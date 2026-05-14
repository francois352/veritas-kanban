import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const AGENTS_URL =
  'https://raw.githubusercontent.com/francois352/neuroclaw-agent-collab/main/docs/registry/agents.json';

let cachedAgents: Set<string> | null = null;
let cachedAt = 0;

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getValidAgents(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedAgents && now - cachedAt < 10 * 60_000) return cachedAgents;
  try {
    const res = await fetch(AGENTS_URL);
    const data = (await res.json()) as Array<{ id?: string }>;
    const ids = new Set(data.map((a) => a.id).filter(Boolean) as string[]);
    if (ids.size > 0) {
      cachedAgents = ids;
      cachedAt = now;
      return ids;
    }
  } catch {
    // ignore fetch failures
  }
  return cachedAgents ?? new Set();
}

export async function verifyKanbanSignature(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.path.startsWith('/tasks') && !req.path.startsWith('/backlog')) return next();

  const graceDays = Number(process.env.KANBAN_SIG_GRACE_DAYS ?? '30');
  const enforceFrom = new Date('2026-01-01T00:00:00Z').getTime() + graceDays * 86_400_000;
  const inGrace = Date.now() < enforceFrom;

  const actor = req.header('X-Kanban-Actor');
  const ts = req.header('X-Kanban-Ts');
  const sig = req.header('X-Kanban-Sig');
  if (!actor || !ts || !sig) {
    if (inGrace) return next();
    return res.status(401).json({ error: 'Missing kanban signature headers' });
  }

  const validAgents = await getValidAgents();
  if (validAgents.size > 0 && !validAgents.has(actor)) {
    return res.status(401).json({ error: 'Invalid kanban actor' });
  }

  const reqTs = Date.parse(ts);
  if (!Number.isFinite(reqTs) || Math.abs(Date.now() - reqTs) > 60_000) {
    return res.status(401).json({ error: 'Timestamp skew exceeds 60 seconds' });
  }

  const secret =
    process.env[`KANBAN_HMAC_SECRET_${actor.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (!secret) return res.status(401).json({ error: 'Missing agent secret' });

  const body = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : '';
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = `${req.method}\n${req.path}\n${ts}\n${bodyHash}`;
  const expected = base64Url(
    createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical).digest()
  );

  const ok =
    expected.length === sig.length &&
    timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
  if (!ok) return res.status(401).json({ error: 'Invalid kanban signature' });

  next();
}
