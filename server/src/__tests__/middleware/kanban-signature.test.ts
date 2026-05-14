import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanSignatureMiddleware } from '../../middleware/kanban-signature.js';

const PATH = '/api/tasks/task_20260513_LlddgY/comments';
const SERVER_SECRET = 'a'.repeat(64);
const WRONG_SECRET = 'b'.repeat(64);

function createApp() {
  const app = express();
  app.use(
    express.json({
      verify(req, _res, buf) {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(kanbanSignatureMiddleware);
  app.post(PATH, (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

function sign({
  method = 'POST',
  requestPath = PATH,
  timestamp,
  body,
  secret = SERVER_SECRET,
}: {
  method?: string;
  requestPath?: string;
  timestamp: string;
  body: string;
  secret?: string;
}) {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const payload = [method, requestPath, timestamp, bodyHash].join('\n');
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('base64url');
}

describe('kanbanSignatureMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      KANBAN_SIG_GRACE_DAYS: '0',
      KANBAN_HMAC_SECRETS: `codex:${SERVER_SECRET}`,
      KANBAN_HMAC_SECRET: '',
      KANBAN_HMAC_SECRET_FILE: '/tmp/veritas-test-missing-kanban-hmac',
      KANBAN_AGENT_REGISTRY_PATH: '',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts a signed kanban write', async () => {
    const app = createApp();
    const body = JSON.stringify({ author: 'codex', text: 'signed write' });
    const timestamp = new Date().toISOString();

    await request(app)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', sign({ timestamp, body }))
      .send(body)
      .expect(201);
  });

  it('accepts a signed kanban write with a query string in the canonical path', async () => {
    const app = createApp();
    const requestPath = `${PATH}?source=cli`;
    const body = JSON.stringify({ author: 'codex', text: 'signed write with query' });
    const timestamp = new Date().toISOString();

    await request(app)
      .post(requestPath)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', sign({ requestPath, timestamp, body }))
      .send(body)
      .expect(201);
  });

  it('rejects an unsigned kanban write after grace', async () => {
    const app = createApp();

    const response = await request(app)
      .post(PATH)
      .send({ author: 'codex', text: 'unsigned write' })
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'KANBAN_SIGNATURE_REQUIRED',
    });
  });

  it('rejects an unsigned kanban write by default in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KANBAN_SIG_GRACE_DAYS;
    const app = createApp();

    const response = await request(app)
      .post(PATH)
      .send({ author: 'codex', text: 'unsigned production write' })
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'KANBAN_SIGNATURE_REQUIRED',
    });
  });

  it('ignores secret files in non-private directories', async () => {
    process.env.KANBAN_HMAC_SECRETS = '';
    process.env.KANBAN_HMAC_SECRET = '';
    const secretPath = path.join(os.tmpdir(), `veritas-kanban-hmac-${process.pid}.txt`);
    fs.writeFileSync(secretPath, `${SERVER_SECRET}\n`, { mode: 0o600 });
    process.env.KANBAN_HMAC_SECRET_FILE = secretPath;

    try {
      const app = createApp();
      const body = JSON.stringify({ author: 'codex', text: 'unsafe secret dir' });
      const timestamp = new Date().toISOString();

      const response = await request(app)
        .post(PATH)
        .set('Content-Type', 'application/json')
        .set('X-Kanban-Actor', 'codex')
        .set('X-Kanban-Ts', timestamp)
        .set('X-Kanban-Sig', sign({ timestamp, body }))
        .send(body)
        .expect(401);

      expect(response.body).toMatchObject({
        code: 'KANBAN_SIGNATURE_SECRET_MISSING',
      });
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  });

  it('rejects a signed write outside the clock-skew tolerance', async () => {
    const app = createApp();
    const body = JSON.stringify({ author: 'codex', text: 'old write' });
    const timestamp = '2026-05-14T00:00:00.000Z';

    const response = await request(app)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', sign({ timestamp, body }))
      .send(body)
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'KANBAN_SIGNATURE_STALE',
    });
  });

  it('rejects a write signed with the wrong secret', async () => {
    const app = createApp();
    const body = JSON.stringify({ author: 'codex', text: 'wrong secret' });
    const timestamp = new Date().toISOString();

    const response = await request(app)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', sign({ timestamp, body, secret: WRONG_SECRET }))
      .send(body)
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'KANBAN_SIGNATURE_INVALID',
    });
  });

  it('rejects replayed signed writes', async () => {
    const app = createApp();
    const body = JSON.stringify({ author: 'codex', text: 'replay me' });
    const timestamp = new Date().toISOString();
    const signature = sign({ timestamp, body });

    await request(app)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', signature)
      .send(body)
      .expect(201);

    const response = await request(app)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set('X-Kanban-Actor', 'codex')
      .set('X-Kanban-Ts', timestamp)
      .set('X-Kanban-Sig', signature)
      .send(body)
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'KANBAN_SIGNATURE_REPLAY',
    });
  });
});
