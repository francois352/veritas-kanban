import { randomUUID } from 'node:crypto';
import type { Comment, Task } from '@veritas-kanban/shared';
import {
  getAgentRegistryService,
  type RegisteredAgent,
} from './agent-registry-service.js';
import { getTaskService, type TaskService } from './task-service.js';
import { broadcastTaskChange } from './broadcast-service.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('stale-task-watchdog');

const STALE_COMMENT_PREFIX = 'STALE CHECK:';
const WATCHDOG_AUTHOR = 'veritas-watchdog';

const DEFAULT_TASK_THRESHOLD_MINUTES = 30;
const DEFAULT_HEARTBEAT_THRESHOLD_MINUTES = 10;
const DEFAULT_COMMENT_THROTTLE_MINUTES = 30;
const DEFAULT_MAX_WATCHDOG_COMMENTS_PER_TASK = 3;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_COMMENTS_PER_RUN = 20;

export type StaleTaskSeverity = 'stale' | 'checkpoint-overdue';

export interface StaleTaskFinding {
  id: string;
  title: string;
  agent?: string;
  severity: StaleTaskSeverity;
  taskAgeMinutes: number | null;
  taskAge: string;
  agentStatus: string;
  heartbeatAgeMinutes: number | null;
  heartbeatAge: string;
  currentTaskId?: string;
  reasons: string[];
  recommendedAction: 'recover | reassign | block | require checkpoint';
  comment: string;
}

export interface StaleTaskReport {
  checkedAt: string;
  taskThresholdMinutes: number;
  heartbeatThresholdMinutes: number;
  findings: StaleTaskFinding[];
}

export interface StaleTaskWatchdogRunResult extends StaleTaskReport {
  commentsPosted: number;
}

export interface StaleTaskWatchdogOptions {
  taskThresholdMinutes?: number;
  heartbeatThresholdMinutes?: number;
  commentThrottleMinutes?: number;
  maxCommentsPerRun?: number;
}

interface WatchdogDependencies {
  taskService?: Pick<TaskService, 'appendComment' | 'getTask' | 'listTasks'>;
  agentRegistry?: Pick<ReturnType<typeof getAgentRegistryService>, 'list'>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesSince(value: string | undefined, nowMs: number): number | null {
  const parsed = parseIso(value);
  if (parsed === null) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 60_000));
}

function formatAge(minutes: number | null): string {
  if (minutes === null) return 'unknown';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h${String(mins).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function normalizeRef(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function slugRef(value: string | undefined): string {
  return normalizeRef(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isWatchdogComment(comment: Comment): boolean {
  return comment.author === WATCHDOG_AUTHOR && comment.text.startsWith(STALE_COMMENT_PREFIX);
}

export class StaleTaskWatchdogService {
  private readonly taskService: Pick<TaskService, 'appendComment' | 'getTask' | 'listTasks'>;
  private readonly agentRegistry: Pick<ReturnType<typeof getAgentRegistryService>, 'list'>;
  private readonly commentThrottleByTask = new Map<string, number>();
  private runInFlight = false;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatchdogDependencies = {}) {
    this.taskService = deps.taskService ?? getTaskService();
    this.agentRegistry = deps.agentRegistry ?? getAgentRegistryService();
  }

  isEnabled(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    return parseBooleanEnv(process.env.VERITAS_STALE_TASK_WATCHDOG_ENABLED, true);
  }

  start(): void {
    if (!this.isEnabled()) {
      log.info('Stale task watchdog disabled');
      return;
    }

    if (this.interval) return;

    const intervalMs = parsePositiveInt(
      process.env.VERITAS_STALE_TASK_WATCHDOG_INTERVAL_MS,
      DEFAULT_INTERVAL_MS
    );

    this.interval = setInterval(() => {
      this.run({ postComments: true }).catch((err) => {
        log.warn({ err }, 'Stale task watchdog run failed');
      });
    }, intervalMs);
    this.interval.unref?.();

    this.run({ postComments: true }).catch((err) => {
      log.warn({ err }, 'Initial stale task watchdog run failed');
    });

    log.info({ intervalMs }, 'Stale task watchdog started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async report(options: StaleTaskWatchdogOptions = {}): Promise<StaleTaskReport> {
    const now = new Date();
    const nowMs = now.getTime();
    const taskThresholdMinutes =
      options.taskThresholdMinutes ??
      parsePositiveInt(
        process.env.VERITAS_STALE_TASK_THRESHOLD_MINUTES,
        DEFAULT_TASK_THRESHOLD_MINUTES
      );
    const heartbeatThresholdMinutes =
      options.heartbeatThresholdMinutes ??
      parsePositiveInt(
        process.env.VERITAS_STALE_HEARTBEAT_THRESHOLD_MINUTES,
        DEFAULT_HEARTBEAT_THRESHOLD_MINUTES
      );

    const [tasks, agents] = await Promise.all([
      this.taskService.listTasks(),
      Promise.resolve(this.agentRegistry.list()),
    ]);

    const agentsByRef = this.indexAgents(agents);
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const findings = tasks
      .filter((task) => task.status === 'in-progress')
      .map((task) =>
        this.assessTask(
          task,
          agentsByRef,
          tasksById,
          nowMs,
          taskThresholdMinutes,
          heartbeatThresholdMinutes
        )
      )
      .filter((finding): finding is StaleTaskFinding => finding !== null)
      .sort((a, b) => {
        const severityWeight: Record<StaleTaskSeverity, number> = {
          stale: 0,
          'checkpoint-overdue': 1,
        };
        const severityOrder = severityWeight[a.severity] - severityWeight[b.severity];
        if (severityOrder !== 0) return severityOrder;
        return (b.taskAgeMinutes ?? 0) - (a.taskAgeMinutes ?? 0);
      });

    return {
      checkedAt: now.toISOString(),
      taskThresholdMinutes,
      heartbeatThresholdMinutes,
      findings,
    };
  }

  async run(
    options: StaleTaskWatchdogOptions & { postComments?: boolean } = {}
  ): Promise<StaleTaskWatchdogRunResult> {
    if (!options.postComments) {
      const report = await this.report(options);
      return { ...report, commentsPosted: 0 };
    }

    if (this.runInFlight) {
      const report = await this.report(options);
      log.info({ findings: report.findings.length }, 'Stale task watchdog run skipped; already running');
      return { ...report, commentsPosted: 0 };
    }

    this.runInFlight = true;

    try {
      const report = await this.report(options);
      let commentsPosted = 0;

      const configuredMaxComments = parsePositiveInt(
        process.env.VERITAS_STALE_TASK_WATCHDOG_MAX_COMMENTS,
        DEFAULT_MAX_COMMENTS_PER_RUN
      );
      const requestedMaxComments = options.maxCommentsPerRun ?? configuredMaxComments;
      const maxComments = Math.min(requestedMaxComments, configuredMaxComments);
      const throttleMinutes =
        options.commentThrottleMinutes ??
        parsePositiveInt(
          process.env.VERITAS_STALE_TASK_COMMENT_THROTTLE_MINUTES,
          DEFAULT_COMMENT_THROTTLE_MINUTES
        );
      const nowMs = Date.now();
      this.pruneCommentThrottle(
        new Set(report.findings.map((finding) => finding.id)),
        nowMs,
        throttleMinutes
      );

      for (const finding of report.findings) {
        if (commentsPosted >= maxComments) break;
        if (await this.postStaleComment(finding, nowMs, throttleMinutes)) {
          commentsPosted++;
        }
      }

      if (report.findings.length > 0 || commentsPosted > 0) {
        log.info(
          { findings: report.findings.length, commentsPosted },
          'Stale task watchdog run complete'
        );
      }

      return { ...report, commentsPosted };
    } finally {
      this.runInFlight = false;
    }
  }

  private indexAgents(agents: RegisteredAgent[]): Map<string, RegisteredAgent> {
    const index = new Map<string, RegisteredAgent>();
    for (const agent of agents) {
      const normalized = normalizeRef(agent.id);
      if (normalized) index.set(normalized, agent);
    }
    for (const agent of agents) {
      for (const key of [agent.name, slugRef(agent.name)]) {
        const normalized = normalizeRef(key);
        if (normalized && !index.has(normalized)) index.set(normalized, agent);
      }
    }
    return index;
  }

  private assessTask(
    task: Task,
    agentsByRef: Map<string, RegisteredAgent>,
    tasksById: Map<string, Task>,
    nowMs: number,
    taskThresholdMinutes: number,
    heartbeatThresholdMinutes: number
  ): StaleTaskFinding | null {
    const agentRef = task.agent;
    const agent =
      agentsByRef.get(normalizeRef(agentRef)) ?? agentsByRef.get(slugRef(agentRef));
    const taskAgeMinutes = minutesSince(task.updated, nowMs);
    const reasons: string[] = [];
    let livenessFailed = false;
    let agentStatus = 'missing';
    let heartbeatAgeMinutes: number | null = null;
    let currentTaskId: string | undefined;
    let activeElsewhere = false;

    if (!agent) {
      reasons.push('assigned agent is not registered');
      livenessFailed = true;
    } else {
      agentStatus = agent.status;
      heartbeatAgeMinutes = minutesSince(agent.lastHeartbeat, nowMs);
      currentTaskId = agent.currentTaskId;

      if (agent.status === 'offline') {
        reasons.push('agent is offline');
        livenessFailed = true;
      } else if (agent.status !== 'busy') {
        reasons.push(`agent status is ${agent.status}`);
        livenessFailed = true;
      }

      if (heartbeatAgeMinutes === null) {
        reasons.push('agent heartbeat timestamp is missing or invalid');
        livenessFailed = true;
      } else if (heartbeatAgeMinutes > heartbeatThresholdMinutes) {
        reasons.push(`agent heartbeat is older than ${heartbeatThresholdMinutes}m`);
        livenessFailed = true;
      }

      if (currentTaskId && currentTaskId !== task.id) {
        const registryTask = tasksById.get(currentTaskId);
        if (
          registryTask?.status === 'in-progress' &&
          this.isTaskAssignedToAgent(registryTask, agent)
        ) {
          activeElsewhere = true;
        } else {
          reasons.push(`agent registry points at ${currentTaskId}, not this task`);
          livenessFailed = true;
        }
      } else if (agent.status === 'busy' && !currentTaskId) {
        reasons.push('agent is busy but has no currentTaskId');
        livenessFailed = true;
      }
    }

    const checkpointOverdue =
      taskAgeMinutes === null || taskAgeMinutes > taskThresholdMinutes;
    if (checkpointOverdue) {
      if (activeElsewhere && currentTaskId) {
        reasons.push(`agent is busy on another active task (${currentTaskId})`);
      }
      reasons.push(`task has no update/checkpoint within ${taskThresholdMinutes}m`);
    }

    if (reasons.length === 0) return null;

    const severity: StaleTaskSeverity = livenessFailed ? 'stale' : 'checkpoint-overdue';
    const finding: StaleTaskFinding = {
      id: task.id,
      title: task.title,
      agent: agentRef,
      severity,
      taskAgeMinutes,
      taskAge: formatAge(taskAgeMinutes),
      agentStatus,
      heartbeatAgeMinutes,
      heartbeatAge: formatAge(heartbeatAgeMinutes),
      currentTaskId,
      reasons,
      recommendedAction: 'recover | reassign | block | require checkpoint',
      comment: '',
    };
    finding.comment = this.buildComment(finding);
    return finding;
  }

  private buildComment(finding: Omit<StaleTaskFinding, 'comment'>): string {
    return (
      `${STALE_COMMENT_PREFIX} Task needs attention. ` +
      `Severity=${finding.severity}; last task update=${finding.taskAge} ago; ` +
      `agent=${finding.agent || 'unassigned'} status=${finding.agentStatus}; ` +
      `heartbeat=${finding.heartbeatAge} ago; ` +
      `currentTaskId=${finding.currentTaskId || '-'}; ` +
      `reasons=${finding.reasons.join('; ')}. ` +
      'Outcome needed: recover the work, reassign it, block it, or require a fresh checkpoint.'
    ).slice(0, 2000);
  }

  private async postStaleComment(
    finding: StaleTaskFinding,
    nowMs: number,
    throttleMinutes: number
  ): Promise<boolean> {
    const task = await this.taskService.getTask(finding.id);
    if (!task) return false;

    if (this.hasRecentInMemoryWatchdogComment(task.id, nowMs, throttleMinutes)) {
      return false;
    }

    const taskUpdatedAt = parseIso(task.updated) ?? 0;
    const maxCommentsPerTask = parsePositiveInt(
      process.env.VERITAS_STALE_TASK_MAX_COMMENTS_PER_TASK,
      DEFAULT_MAX_WATCHDOG_COMMENTS_PER_TASK
    );
    const watchdogCommentCount = (task.comments ?? []).filter((comment) => {
      const timestamp = parseIso(comment.timestamp);
      return isWatchdogComment(comment) && timestamp !== null && timestamp >= taskUpdatedAt;
    }).length;
    if (watchdogCommentCount >= maxCommentsPerTask) {
      log.info(
        { taskId: task.id, watchdogCommentCount, maxCommentsPerTask },
        'Stale task watchdog comment cap reached'
      );
      return false;
    }

    const recentCommentAt = this.getRecentWatchdogCommentTimestamp(
      task.comments ?? [],
      nowMs,
      throttleMinutes,
      taskUpdatedAt
    );
    if (recentCommentAt !== null) {
      this.commentThrottleByTask.set(task.id, recentCommentAt);
      return false;
    }

    const comment: Comment = {
      id: `comment_${randomUUID()}`,
      author: WATCHDOG_AUTHOR,
      text: finding.comment,
      timestamp: new Date(nowMs).toISOString(),
    };

    this.commentThrottleByTask.set(task.id, nowMs);
    let updated: Task | null = null;
    try {
      updated = await this.taskService.appendComment(task.id, comment, { touchUpdated: false });
    } catch (err) {
      this.commentThrottleByTask.delete(task.id);
      log.warn({ err, taskId: task.id }, 'Stale task watchdog comment append failed');
      return false;
    }
    if (!updated) {
      this.commentThrottleByTask.delete(task.id);
      log.warn({ taskId: task.id }, 'Stale task watchdog failed to persist comment');
      return false;
    }

    broadcastTaskChange('updated', task.id);
    return true;
  }

  private hasRecentInMemoryWatchdogComment(
    taskId: string,
    nowMs: number,
    throttleMinutes: number
  ): boolean {
    const lastPostedAt = this.commentThrottleByTask.get(taskId);
    if (lastPostedAt === undefined) return false;

    const throttleMs = throttleMinutes * 60_000;
    if (nowMs - lastPostedAt < throttleMs) return true;

    this.commentThrottleByTask.delete(taskId);
    return false;
  }

  private pruneCommentThrottle(
    activeFindingIds: Set<string>,
    nowMs: number,
    throttleMinutes: number
  ): void {
    const throttleMs = throttleMinutes * 60_000;
    for (const [taskId, postedAt] of this.commentThrottleByTask.entries()) {
      if (!activeFindingIds.has(taskId) || nowMs - postedAt >= throttleMs) {
        this.commentThrottleByTask.delete(taskId);
      }
    }
  }

  private isTaskAssignedToAgent(task: Task, agent: RegisteredAgent): boolean {
    const assignedRef = normalizeRef(task.agent);
    if (!assignedRef) return false;

    return [agent.id, agent.name, slugRef(agent.name)].some(
      (candidate) => normalizeRef(candidate) === assignedRef
    );
  }

  private getRecentWatchdogCommentTimestamp(
    comments: Comment[],
    nowMs: number,
    throttleMinutes: number,
    ignoreBeforeMs: number
  ): number | null {
    const throttleMs = throttleMinutes * 60_000;
    let latest: number | null = null;

    for (const comment of comments) {
      if (!isWatchdogComment(comment)) continue;
      const timestamp = parseIso(comment.timestamp);
      if (timestamp !== null && timestamp >= ignoreBeforeMs && nowMs - timestamp < throttleMs) {
        latest = latest === null ? timestamp : Math.max(latest, timestamp);
      }
    }

    return latest;
  }
}

let instance: StaleTaskWatchdogService | null = null;

export function getStaleTaskWatchdogService(): StaleTaskWatchdogService {
  if (!instance) {
    instance = new StaleTaskWatchdogService();
  }
  return instance;
}

export function disposeStaleTaskWatchdogService(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}
