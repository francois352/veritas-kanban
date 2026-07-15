import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DurationMetrics,
  MetricsPeriod,
  RunMetrics,
  TaskMetrics,
  TokenMetrics,
  TrendComparison,
} from '../../services/metrics/types.js';

const mocks = vi.hoisted(() => ({
  computeAllMetrics: vi.fn(),
  computeTaskCost: vi.fn(),
}));

vi.mock('../../services/telemetry-service.js', () => ({
  getTelemetryService: vi.fn(),
}));

vi.mock('../../services/task-service.js', () => ({
  TaskService: vi.fn().mockImplementation(function TaskService() {
    return {};
  }),
}));

vi.mock('../../services/metrics/helpers.js', () => ({
  TELEMETRY_DIR: '/tmp/veritas-test-telemetry',
}));

vi.mock('../../services/metrics/task-metrics.js', () => ({
  computeTaskMetrics: vi.fn(),
  computeVelocityMetrics: vi.fn(),
}));

vi.mock('../../services/metrics/run-metrics.js', () => ({
  computeRunMetrics: vi.fn(),
  computeDurationMetrics: vi.fn(),
  computeFailedRuns: vi.fn(),
}));

vi.mock('../../services/metrics/token-metrics.js', () => ({
  computeTokenMetrics: vi.fn(),
  computeBudgetMetrics: vi.fn(),
}));

vi.mock('../../services/metrics/dashboard-metrics.js', () => ({
  computeAllMetrics: mocks.computeAllMetrics,
  computeTaskCost: mocks.computeTaskCost,
  computeTrends: vi.fn(),
  computeAgentComparison: vi.fn(),
  computeUtilization: vi.fn(),
}));

const makeAllMetrics = (runs: number) => {
  const tasks: TaskMetrics = {
    byStatus: {
      todo: 0,
      'in-progress': 0,
      blocked: 0,
      done: runs,
      cancelled: 0,
    },
    byBlockedReason: {
      'waiting-on-feedback': 0,
      'technical-snag': 0,
      prerequisite: 0,
      other: 0,
      unspecified: 0,
    },
    total: runs,
    completed: runs,
    archived: 0,
  };
  const runMetrics: RunMetrics = {
    period: '7d',
    runs,
    successes: runs,
    failures: 0,
    errors: 0,
    errorRate: 0,
    successRate: 1,
    byAgent: [],
  };
  const tokens: TokenMetrics = {
    period: '7d',
    totalTokens: runs,
    inputTokens: runs,
    outputTokens: 0,
    cacheTokens: 0,
    runs,
    perSuccessfulRun: {
      avg: runs,
      p50: runs,
      p95: runs,
    },
    byAgent: [],
  };
  const duration: DurationMetrics = {
    period: '7d',
    runs,
    avgMs: runs,
    p50Ms: runs,
    p95Ms: runs,
    byAgent: [],
  };
  const trends: TrendComparison = {
    runsTrend: 'flat',
    runsChange: 0,
    successRateTrend: 'flat',
    successRateChange: 0,
    tokensTrend: 'flat',
    tokensChange: 0,
    durationTrend: 'flat',
    durationChange: 0,
  };

  return { tasks, runs: runMetrics, tokens, duration, trends };
};

describe('MetricsService cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-26T10:00:00.000Z'));
    mocks.computeAllMetrics.mockReset();
    mocks.computeTaskCost.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deduplicates concurrent dashboard metric calls and refreshes after the TTL', async () => {
    const { MetricsService } = await import('../../services/metrics/metrics-service.js');
    const first = makeAllMetrics(1);
    const second = makeAllMetrics(2);
    mocks.computeAllMetrics.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const service = new MetricsService('/tmp/veritas-test-telemetry');
    const [a, b] = await Promise.all([service.getAllMetrics('7d'), service.getAllMetrics('7d')]);
    const c = await service.getAllMetrics('7d');

    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(c).toBe(first);
    expect(mocks.computeAllMetrics).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    const d = await service.getAllMetrics('7d');

    expect(d).toBe(second);
    expect(mocks.computeAllMetrics).toHaveBeenCalledTimes(2);
  });

  it('uses period/project/date parameters as separate cache keys', async () => {
    const { MetricsService } = await import('../../services/metrics/metrics-service.js');
    mocks.computeAllMetrics.mockResolvedValue(makeAllMetrics(1));

    const service = new MetricsService('/tmp/veritas-test-telemetry');
    await service.getAllMetrics('7d', 'alpha');
    await service.getAllMetrics('7d', 'beta');
    await service.getAllMetrics('30d' as MetricsPeriod, 'alpha');

    expect(mocks.computeAllMetrics).toHaveBeenCalledTimes(3);
  });

  it('evicts rejected dashboard metric loads instead of caching the failure', async () => {
    const { MetricsService } = await import('../../services/metrics/metrics-service.js');
    const error = new Error('telemetry unavailable');
    mocks.computeAllMetrics.mockRejectedValueOnce(error).mockResolvedValueOnce(makeAllMetrics(1));

    const service = new MetricsService('/tmp/veritas-test-telemetry');

    await expect(service.getAllMetrics('7d')).rejects.toThrow('telemetry unavailable');
    await expect(service.getAllMetrics('7d')).resolves.toEqual(makeAllMetrics(1));
    expect(mocks.computeAllMetrics).toHaveBeenCalledTimes(2);
  });

  it('caches task-cost metrics with the same TTL behavior', async () => {
    const { MetricsService } = await import('../../services/metrics/metrics-service.js');
    const first = { period: '7d' as MetricsPeriod, tasks: [], totalCost: 1, avgCostPerTask: 1 };
    const second = { period: '7d' as MetricsPeriod, tasks: [], totalCost: 2, avgCostPerTask: 2 };
    mocks.computeTaskCost.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const service = new MetricsService('/tmp/veritas-test-telemetry');

    await expect(service.getTaskCost('7d')).resolves.toBe(first);
    await expect(service.getTaskCost('7d')).resolves.toBe(first);
    expect(mocks.computeTaskCost).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    await expect(service.getTaskCost('7d')).resolves.toBe(second);
    expect(mocks.computeTaskCost).toHaveBeenCalledTimes(2);
  });
});
