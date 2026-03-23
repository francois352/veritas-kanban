import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockFsAccess = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsStatfs = vi.hoisted(() => vi.fn().mockResolvedValue({
  bfree: 1000000000,
  bsize: 1024,
}));

vi.mock('fs/promises', () => ({
  default: {
    access: mockFsAccess,
    statfs: mockFsStatfs,
    constants: {
      R_OK: 4,
      W_OK: 2,
    },
  },
}));

const mockAgentRegistryService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('../../services/agent-registry-service.js', () => ({
  getAgentRegistryService: () => mockAgentRegistryService,
}));

const mockMetricsService = vi.hoisted(() => ({
  getRunMetrics: vi.fn(),
}));

vi.mock('../../services/metrics/index.js', () => ({
  getMetricsService: () => mockMetricsService,
}));

import { systemHealthRouter } from '../../routes/system-health.js';

describe('System Health Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/system/health', systemHealthRouter);
    app.use(errorHandler);
  });

  describe('GET /api/system/health', () => {
    it('returns system health status as stable', async () => {
      mockAgentRegistryService.list.mockReturnValue([
        { id: 'agent_1', status: 'online' },
      ]);

      mockMetricsService.getRunMetrics.mockResolvedValue({
        runs: 100,
        successRate: 0.95,
        failures: 5,
        errors: 0,
      });

      // Stub checkMemory (which reads process.memoryUsage()) because we can't reliably mock
      // its output via a file mock, but we want a stable output. We don't really have to,
      // but let's just make sure it succeeds.

      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = () => ({ heapUsed: 10, heapTotal: 100 } as any);

      const response = await request(app).get('/api/system/health');

      process.memoryUsage = originalMemoryUsage;

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('stable');
      expect(response.body.signals.agents.status).toBe('ok');
      expect(response.body.signals.operations.status).toBe('ok');
      expect(mockAgentRegistryService.list).toHaveBeenCalled();
      expect(mockMetricsService.getRunMetrics).toHaveBeenCalledWith('24h');
    });

    it('returns system health status as alert if operations success rate is low', async () => {
      mockAgentRegistryService.list.mockReturnValue([
        { id: 'agent_1', status: 'online' },
      ]);

      mockMetricsService.getRunMetrics.mockResolvedValue({
        runs: 100,
        successRate: 0.45, // < 50%
        failures: 55,
        errors: 0,
      });

      const response = await request(app).get('/api/system/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alert');
      expect(response.body.signals.operations.status).toBe('critical');
    });

    it('handles failing to aggregate health', async () => {
      // Create a scenario where checkStorage throws to test the catch block
      mockMetricsService.getRunMetrics.mockRejectedValue(new Error('Failed metrics'));
      // Wait, in `system-health.ts`, a failure in getOperationsSignal is caught internally
      // and returns a fallback.
      // To trigger the outer catch, we need one of the Promise.all functions or synchronous ones
      // to throw, or something else.
      // Let's mock checkMemory to throw
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = () => {
        throw new Error('Memory check failed');
      };

      const response = await request(app).get('/api/system/health');
      process.memoryUsage = originalMemoryUsage;

      expect(response.status).toBe(500);
      expect(response.body.status).toBe('unknown');
      expect(response.body.error).toBe('Failed to aggregate health');
    });
  });
});
