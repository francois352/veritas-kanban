import express from 'express';
import request from 'supertest';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'vitest';
import { verifyKanbanSignature } from '../../middleware/kanban-signature.js';

function sign(method: string, path: string, ts: string, body: unknown, secretHex: string): string {
  const bodyStr = body ? JSON.stringify(body) : '';
  const bodyHash = createHash('sha256').update(bodyStr).digest('hex');
  const canonical = `${method}\n${path}\n${ts}\n${bodyHash}`;
  return createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(canonical)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('kanban signature middleware', () => {
  beforeEach(() => {
    process.env.KANBAN_SIG_GRACE_DAYS = '0';
    process.env.KANBAN_HMAC_SECRET_CODEX = 'a'.repeat(64);
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api', verifyKanbanSignature);
    a.post('/api/tasks/x/comments', (_req, res) => res.status(201).json({ ok: true }));
    return a;
  }

  it('signed-OK', async () => {
    const ts = new Date().toISOString();
    const body = { text: 'hi' };
    const sig = sign('POST', '/tasks/x/comments', ts, body, 'a'.repeat(64));
    await request(app())
      .post('/api/tasks/x/comments')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', ts)
      .set('X-Kanban-Sig', sig)
      .send(body)
      .expect(201);
  });

  it('missing-sig-rejected-after-grace', async () => {
    await request(app()).post('/api/tasks/x/comments').send({ text: 'hi' }).expect(401);
  });

  it('time-skewed-rejected', async () => {
    const ts = new Date(Date.now() - 120_000).toISOString();
    const body = { text: 'hi' };
    const sig = sign('POST', '/tasks/x/comments', ts, body, 'a'.repeat(64));
    await request(app())
      .post('/api/tasks/x/comments')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', ts)
      .set('X-Kanban-Sig', sig)
      .send(body)
      .expect(401);
  });

  it('wrong-secret-rejected', async () => {
    const ts = new Date().toISOString();
    const body = { text: 'hi' };
    const sig = sign('POST', '/tasks/x/comments', ts, body, 'b'.repeat(64));
    await request(app())
      .post('/api/tasks/x/comments')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', ts)
      .set('X-Kanban-Sig', sig)
      .send(body)
      .expect(401);
  });
});
