import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as agentRegistry from '../services/agent-registry-service.js';
import * as metricsService from '../services/metrics/index.js';
import { getSystemHealthService, SystemHealthService } from '../services/system-health-service.js';
import fs from 'fs/promises';

vi.mock('../services/agent-registry-service.js');
vi.mock('../services/metrics/index.js');

describe('SystemHealthService', () => {
  const originalCwd = process.cwd();
  const originalDataDir = process.env.DATA_DIR;
  let tempDir: string;
  let service: SystemHealthService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Proper directory isolation per requirements
    tempDir = await mkdtemp(join(tmpdir(), 'vk-health-'));
    process.chdir(tempDir);
    process.env.DATA_DIR = tempDir;

    service = new SystemHealthService();

    // Default healthy mocks for process/dependencies
    // We cannot reliably mock disk space size with real fs, so we must mock statfs to control it
    // But we let standard fs.access operations work on the real tempDir we just created
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bfree: 100 * 1024,
      bsize: 1024 * 10, // Gives > 100MB free
    } as any);

    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 50,
      heapTotal: 100,
    } as any);

    vi.mocked(agentRegistry.getAgentRegistryService).mockReturnValue({
      list: () => [
        { status: 'online' },
        { status: 'busy' },
      ],
    } as any);

    vi.mocked(metricsService.getMetricsService).mockReturnValue({
      getRunMetrics: async () => ({
        runs: 10,
        successRate: 0.9,
        failures: 1,
        errors: 0,
      }),
    } as any);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalDataDir) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns singleton instance via getSystemHealthService', () => {
    const instance1 = getSystemHealthService();
    const instance2 = getSystemHealthService();
    expect(instance1).toBeInstanceOf(SystemHealthService);
    expect(instance1).toBe(instance2);
  });

  it('returns stable status when everything is healthy', async () => {
    const result = await service.getStatus();

    expect(result.status).toBe('stable');
    expect(result.signals.system.status).toBe('ok');
    expect(result.signals.agents.status).toBe('ok');
    expect(result.signals.operations.status).toBe('ok');
  });

  it('handles missing agent registry gracefully', async () => {
    vi.mocked(agentRegistry.getAgentRegistryService).mockImplementation(() => {
      throw new Error('Registry failed');
    });

    const result = await service.getStatus();
    expect(result.signals.agents).toEqual({
      status: 'ok',
      total: 0,
      online: 0,
      offline: 0,
    });
  });

  it('handles missing metrics gracefully', async () => {
    vi.mocked(metricsService.getMetricsService).mockImplementation(() => {
      throw new Error('Metrics failed');
    });

    const result = await service.getStatus();
    expect(result.signals.operations).toEqual({
      status: 'ok',
      recentRuns: 0,
      successRate: 100,
      failedRuns: 0,
    });
  });

  describe('system signals', () => {
    it('returns warn for system if memory is high', async () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 95,
        heapTotal: 100,
      } as any);

      const result = await service.getStatus();
      expect(result.signals.system.status).toBe('warn');
      expect(result.signals.system.memory).toBe(false);
      expect(result.status).toBe('reviewing');
    });

    it('returns fail for system if storage check fails', async () => {
      // Point DATA_DIR to a path that definitely doesn't exist
      process.env.DATA_DIR = join(tempDir, 'does-not-exist');

      const result = await service.getStatus();
      expect(result.signals.system.status).toBe('fail');
      expect(result.signals.system.storage).toBe(false);
      expect(result.status).toBe('alert');
    });

    it('returns fail for system if disk space is low', async () => {
      vi.spyOn(fs, 'statfs').mockResolvedValue({
        bfree: 1,
        bsize: 1024,
      } as any);

      const result = await service.getStatus();
      expect(result.signals.system.status).toBe('fail');
      expect(result.signals.system.disk).toBe(false);
      expect(result.status).toBe('alert');
    });

    it('returns fail for system if disk statfs throws', async () => {
      vi.spyOn(fs, 'statfs').mockRejectedValue(new Error('Statfs failed'));

      const result = await service.getStatus();
      expect(result.signals.system.status).toBe('fail');
      expect(result.signals.system.disk).toBe(false);
      expect(result.status).toBe('alert');
    });
  });

  describe('agent signals', () => {
    it('returns ok if zero total agents', async () => {
      vi.mocked(agentRegistry.getAgentRegistryService).mockReturnValue({
        list: () => [],
      } as any);

      const result = await service.getStatus();
      expect(result.signals.agents.status).toBe('ok');
    });

    it('returns warn if some agents are offline', async () => {
      vi.mocked(agentRegistry.getAgentRegistryService).mockReturnValue({
        list: () => [
          { status: 'online' },
          { status: 'offline' },
        ],
      } as any);

      const result = await service.getStatus();
      expect(result.signals.agents.status).toBe('warn');
      expect(result.status).toBe('drifting'); // offline > 0 forces drifting
    });

    it('returns critical if all agents are offline', async () => {
      vi.mocked(agentRegistry.getAgentRegistryService).mockReturnValue({
        list: () => [
          { status: 'offline' },
          { status: 'offline' },
        ],
      } as any);

      const result = await service.getStatus();
      expect(result.signals.agents.status).toBe('critical');
      expect(result.status).toBe('elevated');
    });
  });

  describe('operations signals', () => {
    it('returns warn if successRate is < 80%', async () => {
      vi.mocked(metricsService.getMetricsService).mockReturnValue({
        getRunMetrics: async () => ({
          runs: 10,
          successRate: 0.75, // < 80%
          failures: 0,
          errors: 0,
        }),
      } as any);

      const result = await service.getStatus();
      expect(result.signals.operations.status).toBe('warn');
      expect(result.status).toBe('reviewing');
    });

    it('returns warn if failedRuns > 5', async () => {
      vi.mocked(metricsService.getMetricsService).mockReturnValue({
        getRunMetrics: async () => ({
          runs: 20,
          successRate: 0.9,
          failures: 4,
          errors: 2, // Total 6 failed runs
        }),
      } as any);

      const result = await service.getStatus();
      expect(result.signals.operations.status).toBe('warn');
      expect(result.status).toBe('reviewing');
    });

    it('returns critical if successRate is < 50%', async () => {
      vi.mocked(metricsService.getMetricsService).mockReturnValue({
        getRunMetrics: async () => ({
          runs: 10,
          successRate: 0.4, // < 50%
          failures: 0,
          errors: 0,
        }),
      } as any);

      const result = await service.getStatus();
      expect(result.signals.operations.status).toBe('critical');
      // Success rate < 50 forces alert according to determineLevel logic
      expect(result.status).toBe('alert');
    });
  });

  describe('overall status logic', () => {
    it('returns drifting if 2 or more warnings', async () => {
      // Memory warning -> System warn
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 95,
        heapTotal: 100,
      } as any);

      // Operations warn
      vi.mocked(metricsService.getMetricsService).mockReturnValue({
        getRunMetrics: async () => ({
          runs: 10,
          successRate: 0.75,
          failures: 0,
          errors: 0,
        }),
      } as any);

      const result = await service.getStatus();
      expect(result.status).toBe('drifting');
    });

    it('returns elevated if any critical signal (e.g. all agents offline)', async () => {
      // Agents critical
      vi.mocked(agentRegistry.getAgentRegistryService).mockReturnValue({
        list: () => [
          { status: 'offline' },
        ],
      } as any);

      const result = await service.getStatus();
      expect(result.status).toBe('elevated');
    });
  });
});
