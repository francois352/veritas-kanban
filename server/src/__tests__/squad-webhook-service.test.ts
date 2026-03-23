import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { fireSquadWebhook } from '../services/squad-webhook-service.js';
import * as urlValidation from '../utils/url-validation.js';
import type { SquadMessage } from '@veritas-kanban/shared';

// Mock url validation to allow localhost or specific domains
vi.mock('../utils/url-validation.js', () => ({
  validateWebhookUrl: vi.fn(),
}));

describe('SquadWebhookService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-webhook-'));
    process.chdir(tempDir);
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(urlValidation.validateWebhookUrl).mockReturnValue({ valid: true });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const baseMessage: SquadMessage = {
    id: 'msg-1',
    agent: 'veritas',
    message: 'hello world',
    timestamp: new Date().toISOString(),
  };

  const humanMessage: SquadMessage = {
    ...baseMessage,
    agent: 'Human',
  };

  it('does nothing if disabled', async () => {
    await fireSquadWebhook(baseMessage, { enabled: false, mode: 'generic' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips agent messages if notifyOnAgent is false', async () => {
    await fireSquadWebhook(baseMessage, { enabled: true, mode: 'generic', notifyOnAgent: false, notifyOnHuman: true, url: 'http://example.com' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips human messages if notifyOnHuman is false', async () => {
    await fireSquadWebhook(humanMessage, { enabled: true, mode: 'generic', notifyOnAgent: true, notifyOnHuman: false, url: 'http://example.com' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('delivers generic webhook without secret', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'generic',
      notifyOnAgent: true,
      url: 'http://example.com/webhook',
    });

    // We need to flush promises because fireGenericWebhook calls fireWebhookAsync and doesn't await it
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://example.com/webhook', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Veritas-Kanban-Squad-Webhook/1.0',
      },
      body: expect.stringContaining('"message":"hello world"'),
    }));
  });

  it('delivers generic webhook with HMAC signature', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'generic',
      notifyOnAgent: true,
      url: 'http://example.com/webhook',
      secret: 'my-secret',
    });

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers['X-VK-Signature']).toBeDefined();

    const body = callArgs[1]?.body as string;
    const expectedSignature = crypto.createHmac('sha256', 'my-secret').update(body).digest('hex');
    expect(headers['X-VK-Signature']).toBe(`sha256=${expectedSignature}`);
  });

  it('handles generic webhook non-2xx response without throwing to caller', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'generic',
      notifyOnAgent: true,
      url: 'http://example.com/webhook',
    });

    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles generic webhook fetch error without throwing to caller', async () => {
    const fetchMock = vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'generic',
      notifyOnAgent: true,
      url: 'http://example.com/webhook',
    });

    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts generic webhook on timeout', async () => {
    // Mock fetch to never resolve, simulating a timeout
    const fetchMock = vi.mocked(fetch).mockImplementation(
      (url, init) => new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        });
      })
    );

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'generic',
      notifyOnAgent: true,
      url: 'http://example.com/webhook',
    });

    await vi.advanceTimersByTimeAsync(6000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('delivers openclaw webhook', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
      openclawGatewayUrl: 'http://gateway.local',
      openclawGatewayToken: 'token123',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://gateway.local/tools/invoke', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token123',
      },
      body: expect.stringContaining('🗨️ Squad chat from veritas: hello world'),
    }));
  });

  it('blocks SSRF for openclaw mode using validation', async () => {
    vi.mocked(urlValidation.validateWebhookUrl).mockReturnValue({ valid: false, reason: 'Local IP blocked' });
    const fetchMock = vi.mocked(fetch);

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
      openclawGatewayUrl: 'http://169.254.169.254',
      openclawGatewayToken: 'token123',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts openclaw webhook on timeout', async () => {
    vi.mocked(fetch).mockImplementation(
      (url, init) => new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        });
      })
    );

    const promise = fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
      openclawGatewayUrl: 'http://gateway.local',
      openclawGatewayToken: 'token',
    });

    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing for openclaw if gateway details missing', async () => {
    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles OpenClaw webhook non-2xx response without throwing', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
      openclawGatewayUrl: 'http://gateway.local',
      openclawGatewayToken: 'token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles OpenClaw webhook fetch error without throwing', async () => {
    const fetchMock = vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    await fireSquadWebhook(baseMessage, {
      enabled: true,
      mode: 'openclaw',
      notifyOnAgent: true,
      openclawGatewayUrl: 'http://gateway.local',
      openclawGatewayToken: 'token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
