import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@veritas-kanban/shared';
import type { RegisteredAgent } from '../../services/agent-registry-service.js';

vi.mock('../../services/broadcast-service.js', () => ({
  broadcastTaskChange: vi.fn(),
}));

const { StaleTaskWatchdogService } = await import(
  '../../services/stale-task-watchdog-service.js'
);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_20260515_watch',
    title: 'Watch stale worker',
    description: '',
    type: 'code',
    status: 'in-progress',
    priority: 'high',
    agent: 'codex',
    created: '2026-05-15T00:00:00.000Z',
    updated: '2026-05-15T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'codex',
    name: 'Codex',
    capabilities: [{ name: 'code' }],
    status: 'busy',
    registeredAt: '2026-05-15T00:00:00.000Z',
    lastHeartbeat: '2026-05-15T00:40:00.000Z',
    currentTaskId: 'task_20260515_watch',
    ...overrides,
  };
}

function makeService(tasks: Task[], agents: RegisteredAgent[]) {
  const taskService = {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    appendComment: vi.fn(async (id: string, comment: NonNullable<Task['comments']>[number]) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return null;
      tasks[index] = {
        ...tasks[index],
        comments: [...(tasks[index].comments ?? []), comment],
        updated: new Date().toISOString(),
      } as Task;
      return tasks[index];
    }),
  };
  const agentRegistry = {
    list: vi.fn(() => agents),
  };

  const service = new StaleTaskWatchdogService({
    taskService: taskService as any,
    agentRegistry: agentRegistry as any,
  });

  return { service, taskService, agentRegistry };
}

describe('StaleTaskWatchdogService', () => {
  it('reports stale in-progress tasks when worker liveness does not match the task', async () => {
    const { service } = makeService(
      [
        makeTask({
          updated: '2026-05-15T00:00:00.000Z',
        }),
      ],
      [
        makeAgent({
          status: 'offline',
          lastHeartbeat: '2026-05-15T00:10:00.000Z',
          currentTaskId: 'task_20260515_other',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const report = await service.report({
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
    });
    vi.useRealTimers();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: 'task_20260515_watch',
      severity: 'stale',
      agentStatus: 'offline',
    });
    expect(report.findings[0].reasons).toContain('agent is offline');
    expect(report.findings[0].reasons).toContain('agent heartbeat is older than 10m');
    expect(report.findings[0].reasons).toContain(
      'agent registry points at task_20260515_other, not this task'
    );
    expect(report.findings[0].comment).toContain('Outcome needed: recover the work');
  });

  it('does not report a healthy current in-progress task', async () => {
    const { service } = makeService(
      [
        makeTask({
          updated: '2026-05-15T00:40:00.000Z',
        }),
      ],
      [makeAgent()]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const report = await service.report({
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
    });
    vi.useRealTimers();

    expect(report.findings).toHaveLength(0);
  });

  it('posts one watchdog comment and throttles repeat comments', async () => {
    const tasks = [
      makeTask({
        updated: '2026-05-15T00:00:00.000Z',
        comments: [],
      }),
    ];
    const { service, taskService } = makeService(
      tasks,
      [
        makeAgent({
          status: 'offline',
          lastHeartbeat: '2026-05-15T00:10:00.000Z',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const first = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });
    const second = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });
    vi.useRealTimers();

    expect(first.commentsPosted).toBe(1);
    expect(second.commentsPosted).toBe(0);
    expect(taskService.appendComment).toHaveBeenCalledTimes(1);
    expect(tasks[0].comments).toHaveLength(1);
    expect(tasks[0].comments?.[0].author).toBe('veritas-watchdog');
    expect(tasks[0].comments?.[0].text).toContain('STALE CHECK:');
  });

  it('keeps an in-memory throttle when persisted comments are normalized', async () => {
    const tasks = [
      makeTask({
        updated: '2026-05-15T00:00:00.000Z',
        comments: [],
      }),
    ];
    const { service, taskService } = makeService(
      tasks,
      [
        makeAgent({
          status: 'offline',
          lastHeartbeat: '2026-05-15T00:10:00.000Z',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const first = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });

    tasks[0].comments = [];

    vi.setSystemTime(new Date('2026-05-15T00:50:00.000Z'));
    const second = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });
    vi.useRealTimers();

    expect(first.commentsPosted).toBe(1);
    expect(second.commentsPosted).toBe(0);
    expect(taskService.appendComment).toHaveBeenCalledTimes(1);
  });

  it('removes memory throttle entries when a task recovers', async () => {
    const tasks = [
      makeTask({
        updated: '2026-05-15T00:00:00.000Z',
        comments: [],
      }),
    ];
    const { service, taskService } = makeService(
      tasks,
      [
        makeAgent({
          status: 'offline',
          lastHeartbeat: '2026-05-15T00:10:00.000Z',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const first = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });

    tasks[0].status = 'done';
    tasks[0].comments = [];

    vi.setSystemTime(new Date('2026-05-15T00:50:00.000Z'));
    const recovered = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });

    tasks[0].status = 'in-progress';
    const staleAgain = await service.run({
      postComments: true,
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
      commentThrottleMinutes: 30,
    });
    vi.useRealTimers();

    expect(first.commentsPosted).toBe(1);
    expect(recovered.commentsPosted).toBe(0);
    expect(staleAgain.commentsPosted).toBe(1);
    expect(taskService.appendComment).toHaveBeenCalledTimes(2);
  });

  it('treats older non-active tasks as checkpoint issues when the agent is busy elsewhere', async () => {
    const { service } = makeService(
      [
        makeTask({
          id: 'task_20260515_old',
          title: 'Older task still assigned',
          updated: '2026-05-15T00:00:00.000Z',
          agent: 'codex',
        }),
        makeTask({
          id: 'task_20260515_active',
          title: 'Active task',
          updated: '2026-05-15T00:40:00.000Z',
          agent: 'codex',
        }),
      ],
      [
        makeAgent({
          currentTaskId: 'task_20260515_active',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const report = await service.report({
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
    });
    vi.useRealTimers();

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: 'task_20260515_old',
      severity: 'checkpoint-overdue',
    });
    expect(report.findings[0].reasons).toContain(
      'agent is busy on another active task (task_20260515_active)'
    );
  });

  it('reports stale when currentTaskId points at another agent task', async () => {
    const { service } = makeService(
      [
        makeTask({
          id: 'task_20260515_old',
          updated: '2026-05-15T00:00:00.000Z',
          agent: 'codex',
        }),
        makeTask({
          id: 'task_20260515_other_agent',
          updated: '2026-05-15T00:40:00.000Z',
          agent: 'claude',
        }),
      ],
      [
        makeAgent({
          currentTaskId: 'task_20260515_other_agent',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const report = await service.report({
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
    });
    vi.useRealTimers();

    const finding = report.findings.find((candidate) => candidate.id === 'task_20260515_old');
    expect(finding).toMatchObject({
      id: 'task_20260515_old',
      severity: 'stale',
    });
    expect(finding?.reasons).toContain(
      'agent registry points at task_20260515_other_agent, not this task'
    );
  });

  it('prioritizes stale liveness failures before checkpoint-only findings', async () => {
    const { service } = makeService(
      [
        makeTask({
          id: 'task_20260515_checkpoint',
          title: 'Checkpoint overdue only',
          updated: '2026-05-15T00:00:00.000Z',
          agent: 'checkpoint-agent',
        }),
        makeTask({
          id: 'task_20260515_stale',
          title: 'Offline worker',
          updated: '2026-05-15T00:20:00.000Z',
          agent: 'stale-agent',
        }),
      ],
      [
        makeAgent({
          id: 'checkpoint-agent',
          name: 'Checkpoint Agent',
          currentTaskId: 'task_20260515_checkpoint',
        }),
        makeAgent({
          id: 'stale-agent',
          name: 'Stale Agent',
          status: 'offline',
          lastHeartbeat: '2026-05-15T00:10:00.000Z',
          currentTaskId: 'task_20260515_stale',
        }),
      ]
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T00:45:00.000Z'));
    const report = await service.report({
      taskThresholdMinutes: 30,
      heartbeatThresholdMinutes: 10,
    });
    vi.useRealTimers();

    expect(report.findings.map((finding) => finding.id)).toEqual([
      'task_20260515_stale',
      'task_20260515_checkpoint',
    ]);
  });
});
