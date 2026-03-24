/**
 * System Health Routes — test coverage for #250
 *
 * Tests HTTP status codes and response shape for /api/v1/system/health
 * Note: This route is mounted BEFORE auth middleware (no auth required).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock dependencies before importing route ─────────────────────────────────

const { mockRegistry, mockMetrics } = vi.hoisted(() => ({
  mockRegistry: {
    list: vi.fn(),
  },
  mockMetrics: {
    getRunMetrics: vi.fn(),
  },
}));

vi.mock('../../services/agent-registry-service.js', () => ({
  getAgentRegistryService: () => mockRegistry,
}));

vi.mock('../../services/metrics/index.js', () => ({
  getMetricsService: () => mockMetrics,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    statfs: vi.fn().mockResolvedValue({ bfree: 1000000, bsize: 4096 }),
  };
});

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { systemHealthRouter } from '../../routes/system-health.js';

// ── App builder ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  // No auth middleware — system-health is public by design
  app.use('/', systemHealthRouter);
  return app;
}

const healthyRunMetrics = {
  runs: 100,
  successRate: 0.95,
  failures: 3,
  errors: 2,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('System Health Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();

    // Default: healthy state
    mockRegistry.list.mockReturnValue([
      { id: 'agent_1', name: 'codex', status: 'online' },
      { id: 'agent_2', name: 'veritas', status: 'busy' },
    ]);
    mockMetrics.getRunMetrics.mockResolvedValue(healthyRunMetrics);
  });

  // ── No auth required ───────────────────────────────────────────────────────

  describe('auth enforcement', () => {
    it('returns 200 without any authentication token', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    });

    it('returns 200 with no Authorization header', async () => {
      const res = await request(app).get('/').set('Authorization', '');
      expect(res.status).toBe(200);
    });
  });

  // ── GET / ──────────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns 200 with valid health response structure', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        timestamp: expect.any(String),
        status: expect.any(String),
        signals: {
          system: expect.objectContaining({
            status: expect.any(String),
            storage: expect.any(Boolean),
            disk: expect.any(Boolean),
            memory: expect.any(Boolean),
          }),
          agents: expect.objectContaining({
            status: expect.any(String),
            total: expect.any(Number),
            online: expect.any(Number),
            offline: expect.any(Number),
          }),
          operations: expect.objectContaining({
            status: expect.any(String),
            recentRuns: expect.any(Number),
            successRate: expect.any(Number),
            failedRuns: expect.any(Number),
          }),
        },
      });
    });

    it('returns "stable" status when all signals are healthy', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('stable');
    });

    it('returns "elevated" status when all agents are offline', async () => {
      mockRegistry.list.mockReturnValue([
        { id: 'agent_1', name: 'codex', status: 'offline' },
        { id: 'agent_2', name: 'veritas', status: 'offline' },
      ]);
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(['elevated', 'drifting', 'alert']).toContain(res.body.status);
    });

    it('returns "alert" status when success rate is below 50%', async () => {
      mockMetrics.getRunMetrics.mockResolvedValue({
        runs: 100,
        successRate: 0.3,
        failures: 50,
        errors: 20,
      });
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alert');
    });

    it('includes ISO timestamp', async () => {
      const before = new Date().toISOString();
      const res = await request(app).get('/');
      const after = new Date().toISOString();
      expect(res.status).toBe(200);
      const ts = new Date(res.body.timestamp).toISOString();
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });

    it('returns valid agent counts', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      const agents = res.body.signals.agents;
      expect(agents.total).toBe(2);
      expect(agents.online).toBe(2);
      expect(agents.offline).toBe(0);
      expect(agents.status).toBe('ok');
    });

    it('returns valid operations data', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      const ops = res.body.signals.operations;
      expect(ops.recentRuns).toBe(100);
      expect(ops.successRate).toBe(95);
      expect(ops.failedRuns).toBe(5); // 3 failures + 2 errors
    });

    it('handles empty agent registry gracefully', async () => {
      mockRegistry.list.mockReturnValue([]);
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.signals.agents.total).toBe(0);
      expect(res.body.signals.agents.status).toBe('ok');
    });

    it('handles metrics service error gracefully', async () => {
      mockMetrics.getRunMetrics.mockRejectedValue(new Error('Metrics unavailable'));
      const res = await request(app).get('/');
      // Graceful degradation: still 200, operations fallback
      expect(res.status).toBe(200);
      expect(res.body.signals.operations.successRate).toBe(100);
    });

    it('handles agent registry error gracefully', async () => {
      mockRegistry.list.mockImplementation(() => {
        throw new Error('Registry error');
      });
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.signals.agents.total).toBe(0);
    });
  });
});
