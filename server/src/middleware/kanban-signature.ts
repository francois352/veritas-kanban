import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('kanban-signature');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET_RE = /^[a-f0-9]{64}$/i;
const ACTOR_RE = /^[a-zA-Z0-9._:-]{1,100}$/;
const DEFAULT_DEV_GRACE_DAYS = 30;
const DEFAULT_PRODUCTION_GRACE_DAYS = 0;
const MAX_CLOCK_SKEW_MS = 60_000;
const CONFIG_CACHE_TTL_MS = 30_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SEEN_SIGNATURES = 10_000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const seenSignatures = new Map<string, number>();

let actorSecretCache:
  | {
      raw: string;
      secrets: Map<string, string>;
    }
  | undefined;
let allowedActorsCache:
  | {
      path: string;
      mtimeMs: number;
      size: number;
      loadedAt: number;
      actors: Set<string>;
    }
  | undefined;

type RawBodyRequest = Request & { rawBody?: string };

function getHeader(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return value?.trim() || undefined;
}

function parseGraceDays(): number {
  const raw = process.env.KANBAN_SIG_GRACE_DAYS;
  const defaultGraceDays =
    process.env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_GRACE_DAYS : DEFAULT_DEV_GRACE_DAYS;
  if (raw === undefined || raw.trim() === '') return defaultGraceDays;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultGraceDays;
  return parsed;
}

function isGraceActive(): boolean {
  return parseGraceDays() > 0;
}

export function hashKanbanBody(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export function buildKanbanSigningPayload(
  method: string,
  requestPath: string,
  timestamp: string,
  bodyHash: string
): string {
  return [method.toUpperCase(), requestPath, timestamp, bodyHash].join('\n');
}

function canonicalRequestPath(requestPath: string): string {
  const url = new URL(requestPath, 'http://kanban.local');
  return `${url.pathname}${url.search}`;
}

function signPayload(secret: string, payload: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readFileDescriptorUtf8(fd: number, maxBytes = Number.MAX_SAFE_INTEGER): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(8192);
  let bytesRead = 0;
  let totalBytes = 0;

  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new Error('File exceeds maximum allowed size');
    }
    if (bytesRead > 0) {
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } while (bytesRead > 0);

  return Buffer.concat(chunks).toString('utf8');
}

function parseActorSecretMap(): Map<string, string> {
  const raw = process.env.KANBAN_HMAC_SECRETS || '';
  if (actorSecretCache?.raw === raw) {
    return actorSecretCache.secrets;
  }

  const entries = raw.split(/[,\n]/);
  const secrets = new Map<string, string>();

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.includes('=') ? '=' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0) continue;

    const actor = trimmed.slice(0, index).trim();
    const secret = trimmed.slice(index + 1).trim();
    if (ACTOR_RE.test(actor) && SECRET_RE.test(secret)) {
      secrets.set(actor, secret);
    }
  }

  actorSecretCache = { raw, secrets };
  return secrets;
}

function isPrivateDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function readSharedSecretFile(): string | null {
  const secretPath =
    process.env.KANBAN_HMAC_SECRET_FILE?.trim() ||
    path.join(os.homedir(), '.secrets', 'kanban-hmac');

  if (!isPrivateDirectory(path.dirname(secretPath))) {
    log.warn({ secretPath }, 'Ignoring kanban HMAC secret file in non-private directory');
    return null;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(secretPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if ((stat.mode & 0o077) !== 0) {
      log.warn({ secretPath }, 'Ignoring kanban HMAC secret file with group/world permissions');
      return null;
    }

    const secret = readFileDescriptorUtf8(fd, 1024).trim();
    return SECRET_RE.test(secret) ? secret : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function resolveSecret(actor: string): string | null {
  const actorSecrets = parseActorSecretMap();
  const actorSecret = actorSecrets.get(actor);
  if (actorSecret) return actorSecret;

  const sharedEnvSecret = process.env.KANBAN_HMAC_SECRET?.trim();
  if (sharedEnvSecret && SECRET_RE.test(sharedEnvSecret)) return sharedEnvSecret;

  return readSharedSecretFile();
}

function loadAllowedActors(): Set<string> | null {
  const registryPath = process.env.KANBAN_AGENT_REGISTRY_PATH?.trim();
  if (!registryPath) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(registryPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('Actor registry must be a regular file');
    }
    if (stat.size > MAX_REGISTRY_BYTES) {
      throw new Error('Actor registry is larger than 1 MiB');
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error('Actor registry must not be group/world writable');
    }
    if (
      allowedActorsCache &&
      allowedActorsCache.path === registryPath &&
      allowedActorsCache.mtimeMs === stat.mtimeMs &&
      allowedActorsCache.size === stat.size &&
      Date.now() - allowedActorsCache.loadedAt < CONFIG_CACHE_TTL_MS
    ) {
      return allowedActorsCache.actors;
    }

    const parsed = JSON.parse(readFileDescriptorUtf8(fd, MAX_REGISTRY_BYTES)) as Array<{
      id?: unknown;
      addresses?: { kanban_actor?: unknown };
    }>;
    const allowed = new Set<string>();

    for (const agent of parsed) {
      if (typeof agent.id === 'string' && ACTOR_RE.test(agent.id)) {
        allowed.add(agent.id);
      }
      const kanbanActor = agent.addresses?.kanban_actor;
      if (typeof kanbanActor === 'string' && ACTOR_RE.test(kanbanActor)) {
        allowed.add(kanbanActor);
      }
    }

    allowedActorsCache = {
      path: registryPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      loadedAt: Date.now(),
      actors: allowed,
    };
    return allowed;
  } catch (err) {
    log.warn({ err, registryPath }, 'Failed to load kanban actor registry');
    if (allowedActorsCache?.path === registryPath) {
      return allowedActorsCache.actors;
    }
    return new Set();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function reject(res: Response, code: string, message: string, status = 401): void {
  res.status(status).json({ code, message });
}

function pruneSeenSignatures(now: number): void {
  for (const [key, expiresAt] of seenSignatures.entries()) {
    if (expiresAt <= now) {
      seenSignatures.delete(key);
    }
  }
}

function isReplay(actor: string, signature: string, timestampMs: number): boolean {
  const now = Date.now();
  pruneSeenSignatures(now);

  const key = `${actor}:${signature}`;
  if (seenSignatures.has(key)) return true;
  if (seenSignatures.size >= MAX_SEEN_SIGNATURES) {
    const oldestKey = seenSignatures.keys().next().value;
    if (oldestKey) {
      seenSignatures.delete(oldestKey);
    }
  }

  seenSignatures.set(key, Math.max(now + MAX_CLOCK_SKEW_MS, timestampMs + MAX_CLOCK_SKEW_MS));
  return false;
}

function shouldSkip(req: AuthenticatedRequest): boolean {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) return true;

  // Browser sessions use JWT cookies and cannot hold per-agent HMAC secrets.
  return req.auth?.keyName === 'session';
}

export function kanbanSignatureMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (shouldSkip(req)) {
    return next();
  }

  const actor = getHeader(req, 'X-Kanban-Actor');
  const timestamp = getHeader(req, 'X-Kanban-Ts');
  const signature = getHeader(req, 'X-Kanban-Sig');

  if (!actor && !timestamp && !signature) {
    if (isGraceActive()) {
      return next();
    }
    return reject(res, 'KANBAN_SIGNATURE_REQUIRED', 'Kanban write requests must be HMAC signed');
  }

  if (!actor || !timestamp || !signature) {
    return reject(res, 'KANBAN_SIGNATURE_INCOMPLETE', 'Kanban signature headers are incomplete');
  }

  if (!ACTOR_RE.test(actor)) {
    return reject(res, 'KANBAN_ACTOR_INVALID', 'Kanban actor header is invalid', 403);
  }

  const allowedActors = loadAllowedActors();
  if (allowedActors && !allowedActors.has(actor)) {
    return reject(res, 'KANBAN_ACTOR_UNKNOWN', 'Kanban actor is not in the registry', 403);
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return reject(res, 'KANBAN_SIGNATURE_STALE', 'Kanban signature timestamp is outside tolerance');
  }

  const secret = resolveSecret(actor);
  if (!secret) {
    return reject(res, 'KANBAN_SIGNATURE_SECRET_MISSING', 'No HMAC secret is configured for actor');
  }

  const rawBody = (req as RawBodyRequest).rawBody ?? '';
  const bodyHash = hashKanbanBody(rawBody);
  const requestPath = canonicalRequestPath(req.originalUrl);
  const payload = buildKanbanSigningPayload(req.method, requestPath, timestamp, bodyHash);
  const expected = signPayload(secret, payload);

  if (!safeEqual(signature, expected)) {
    return reject(res, 'KANBAN_SIGNATURE_INVALID', 'Kanban signature is invalid');
  }

  if (isReplay(actor, signature, timestampMs)) {
    return reject(res, 'KANBAN_SIGNATURE_REPLAY', 'Kanban signature has already been used');
  }

  next();
}
