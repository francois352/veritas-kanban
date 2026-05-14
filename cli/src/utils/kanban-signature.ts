import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_SECRET_PATH = path.join(os.homedir(), '.secrets', 'kanban-hmac');
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }

  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function getActor(): string {
  return (
    process.env.KANBAN_ACTOR?.trim() ||
    process.env.VK_KANBAN_ACTOR?.trim() ||
    process.env.USER?.trim() ||
    'unknown'
  );
}

function getSecretPath(): string {
  return process.env.KANBAN_HMAC_SECRET_FILE?.trim() || DEFAULT_SECRET_PATH;
}

function assertPrivateDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`${dir} must be a directory for the kanban HMAC secret`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${dir} must not be a symlink for the kanban HMAC secret`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} must not be readable or writable by group/other users`);
  }
}

function canonicalRequestPath(requestPath: string): string {
  const url = new URL(requestPath, 'http://kanban.local');
  return `${url.pathname}${url.search}`;
}

function readFileDescriptorUtf8(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(8192);
  let bytesRead = 0;

  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead > 0) {
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } while (bytesRead > 0);

  return Buffer.concat(chunks).toString('utf8');
}

function ensureSecret(): string {
  const secretPath = getSecretPath();
  const dir = path.dirname(secretPath);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);

  try {
    const secret = crypto.randomBytes(32).toString('hex');
    const fd = fs.openSync(
      secretPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600
    );
    try {
      fs.writeSync(fd, `${secret}\n`);
    } finally {
      fs.closeSync(fd);
    }
    process.stderr.write(`Created kanban HMAC secret at ${secretPath}\n`);
    return secret;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }

  const fd = fs.openSync(secretPath, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${secretPath} must be a regular file`);
    }

    fs.fchmodSync(fd, 0o600);
    const secret = readFileDescriptorUtf8(fd).trim();
    if (!SECRET_RE.test(secret)) {
      throw new Error(`${secretPath} must contain exactly one 64-character hex HMAC secret`);
    }
    return secret;
  } finally {
    fs.closeSync(fd);
  }
}

function requestBodyToString(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  throw new Error('Kanban HMAC signing only supports string, URLSearchParams, and Buffer bodies');
}

function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function buildPayload(
  method: string,
  requestPath: string,
  timestamp: string,
  bodyHash: string
): string {
  return [method.toUpperCase(), requestPath, timestamp, bodyHash].join('\n');
}

function signPayload(secret: string, payload: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('base64url');
}

export function signKanbanRequest(requestPath: string, options: RequestInit): RequestInit {
  const method = (options.method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(method)) {
    return options;
  }

  const secret = ensureSecret();
  const actor = getActor();
  const timestamp = new Date().toISOString();
  const body = requestBodyToString(options.body);
  const bodyHash = hashBody(body);
  const payload = buildPayload(method, canonicalRequestPath(requestPath), timestamp, bodyHash);
  const signature = signPayload(secret, payload);

  return {
    ...options,
    headers: {
      ...headersToRecord(options.headers),
      'X-Kanban-Actor': actor,
      'X-Kanban-Ts': timestamp,
      'X-Kanban-Sig': signature,
    },
  };
}
