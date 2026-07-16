/**
 * MetricsService - Thin facade that delegates to focused metric modules.
 * Maintains the original class API for backwards compatibility.
 */
import { getTelemetryService } from '../telemetry-service.js';
import { getTaskService, type TaskService } from '../task-service.js';
import { TELEMETRY_DIR } from './helpers.js';
import { computeTaskMetrics, computeVelocityMetrics } from './task-metrics.js';
import { computeRunMetrics, computeDurationMetrics, computeFailedRuns } from './run-metrics.js';
import { computeTokenMetrics, computeBudgetMetrics } from './token-metrics.js';
import {
  computeAllMetrics,
  computeTrends,
  computeAgentComparison,
  computeUtilization,
} from './dashboard-metrics.js';
import type {
  MetricsPeriod,
  TaskMetrics,
  RunMetrics,
  TokenMetrics,
  DurationMetrics,
  TrendComparison,
  TrendsData,
  BudgetMetrics,
  AgentComparisonResult,
  VelocityMetrics,
  FailedRunDetails,
  TaskCostMetrics,
} from './types.js';

type AllMetricsResult = {
  tasks: TaskMetrics;
  runs: RunMetrics;
  tokens: TokenMetrics;
  duration: DurationMetrics;
  trends: TrendComparison;
};

interface MetricsCacheEntry<T> {
  /** null while the loader is in flight — pending entries never expire */
  expiresAt: number | null;
  value: Promise<T>;
}

export class MetricsService {
  private taskService: TaskService;
  private telemetryDir: string;
  // Dashboard polls can otherwise recompute the full telemetry/task snapshot repeatedly.
  // The tradeoff is bounded, intentional staleness for at most this TTL.
  private readonly cacheTtlMs = 10_000;
  private readonly maxCacheEntries = 50;
  private allMetricsCache = new Map<string, MetricsCacheEntry<AllMetricsResult>>();
  private taskCostCache = new Map<string, MetricsCacheEntry<TaskCostMetrics>>();

  constructor(telemetryDir?: string, taskService?: TaskService) {
    // Keep TelemetryService init for potential future use
    getTelemetryService();
    // Reuse the singleton: a private TaskService would hydrate a second full
    // task cache (descriptions + comments), doubling baseline heap pressure.
    this.taskService = taskService ?? getTaskService();
    this.telemetryDir = telemetryDir || TELEMETRY_DIR;
  }

  async getTaskMetrics(project?: string, since?: string | null): Promise<TaskMetrics> {
    return computeTaskMetrics(this.taskService, project, since);
  }

  async getRunMetrics(
    period: MetricsPeriod,
    project?: string,
    from?: string,
    to?: string
  ): Promise<RunMetrics> {
    return computeRunMetrics(this.telemetryDir, period, project, from, to);
  }

  async getTokenMetrics(
    period: MetricsPeriod,
    project?: string,
    from?: string,
    to?: string
  ): Promise<TokenMetrics> {
    return computeTokenMetrics(this.telemetryDir, period, project, from, to);
  }

  async getDurationMetrics(
    period: MetricsPeriod,
    project?: string,
    from?: string,
    to?: string
  ): Promise<DurationMetrics> {
    return computeDurationMetrics(this.telemetryDir, period, project, from, to);
  }

  async getAllMetrics(
    period: MetricsPeriod = '7d',
    project?: string,
    from?: string,
    to?: string
  ): Promise<AllMetricsResult> {
    return this.getCached(this.allMetricsCache, this.cacheKey(period, project, from, to), () =>
      computeAllMetrics(this.taskService, this.telemetryDir, period, project, from, to)
    );
  }

  async getTrends(
    period: MetricsPeriod,
    project?: string,
    from?: string,
    to?: string
  ): Promise<TrendsData> {
    return computeTrends(this.telemetryDir, period, project, from, to);
  }

  async getBudgetMetrics(
    tokenBudget: number,
    costBudget: number,
    warningThreshold: number,
    project?: string
  ): Promise<BudgetMetrics> {
    return computeBudgetMetrics(
      this.telemetryDir,
      tokenBudget,
      costBudget,
      warningThreshold,
      project
    );
  }

  async getAgentComparison(
    period: MetricsPeriod,
    project?: string,
    minRuns = 3
  ): Promise<AgentComparisonResult> {
    return computeAgentComparison(this.telemetryDir, period, project, minRuns);
  }

  async getVelocityMetrics(project?: string, limit = 10): Promise<VelocityMetrics> {
    return computeVelocityMetrics(this.taskService, project, limit);
  }

  async getTaskCost(
    period: MetricsPeriod,
    project?: string,
    from?: string,
    to?: string
  ): Promise<TaskCostMetrics> {
    const { computeTaskCost } = await import('./dashboard-metrics.js');
    return this.getCached(this.taskCostCache, this.cacheKey(period, project, from, to), () =>
      computeTaskCost(this.telemetryDir, this.taskService, period, project, from, to)
    );
  }

  async getUtilization(
    period: MetricsPeriod,
    from?: string,
    to?: string,
    utcOffsetHours?: number
  ): Promise<import('./types.js').UtilizationMetrics> {
    // Use telemetry-based computation (reliable data source)
    return computeUtilization(this.telemetryDir, period, from, to, utcOffsetHours);
  }

  async getFailedRuns(
    period: MetricsPeriod,
    project?: string,
    limit = 50,
    from?: string,
    to?: string
  ): Promise<FailedRunDetails[]> {
    return computeFailedRuns(this.telemetryDir, period, project, limit);
  }

  private cacheKey(...parts: Array<string | undefined>): string {
    return JSON.stringify(parts.map((part) => part ?? null));
  }

  private getCached<T>(
    cache: Map<string, MetricsCacheEntry<T>>,
    key: string,
    loader: () => Promise<T>
  ): Promise<T> {
    const cached = cache.get(key);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
      return cached.value;
    }

    const entry: MetricsCacheEntry<T> = { expiresAt: null, value: undefined as never };
    entry.value = loader().then(
      (result) => {
        // Start the TTL clock at resolution so a loader slower than the TTL
        // still deduplicates concurrent callers instead of spawning a
        // duplicate aggregation.
        entry.expiresAt = Date.now() + this.cacheTtlMs;
        return result;
      },
      (error) => {
        // Only evict our own entry — an older rejection must not delete a
        // newer in-flight or resolved entry under the same key.
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
        throw error;
      }
    );

    cache.set(key, entry);

    if (cache.size > this.maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    return entry.value;
  }
}

// Singleton instance
let instance: MetricsService | null = null;

export function getMetricsService(): MetricsService {
  if (!instance) {
    instance = new MetricsService();
  }
  return instance;
}
