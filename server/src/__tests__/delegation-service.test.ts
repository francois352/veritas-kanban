import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path, { join } from 'path';
import type { DelegationScope, TaskPriority } from '@veritas-kanban/shared';

describe('DelegationService', () => {
  let tempDir: string;
  let service: any;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-delegation-'));

    // DelegationService uses path.resolve(process.cwd(), '..')
    // We can isolate it simply by doing process.chdir into a subfolder of our tempdir
    const runDir = join(tempDir, 'subfolder');
    const fs = await import('fs/promises');
    await fs.mkdir(runDir, { recursive: true });
    process.chdir(runDir);

    // Clear the singleton module so it re-evaluates the const PROJECT_ROOT = path.resolve(process.cwd(), '..')
    vi.resetModules();

    vi.mock('path', async (importOriginal) => {
        const actual: any = await importOriginal();
        return {
          ...actual,
          resolve: (...args: string[]) => {
            // DelegationService resolves PROJECT_ROOT = path.resolve(process.cwd(), '..')
            // Let's intercept to return our tempDir
            if (args.length === 2 && args[1] === '..') {
              return tempDir;
            }
            return actual.resolve(...args);
          },
          join: (...args: string[]) => {
            const joined = actual.join(...args);
            // Ensure any path to .veritas-kanban inside this service gets mapped to tempDir/.veritas-kanban
            if (joined === '/.veritas-kanban') {
                return actual.join(tempDir, '.veritas-kanban');
            }
            if (joined === actual.join(process.cwd(), '..', '.veritas-kanban')) {
                return actual.join(tempDir, '.veritas-kanban');
            }
            if (args.includes('.veritas-kanban')) {
              const after = args.slice(args.indexOf('.veritas-kanban') + 1);
              return actual.join(tempDir, '.veritas-kanban', ...after);
            }
            return joined;
          }
        };
      });

    const delegationServiceModule = await import('../services/delegation-service.js');
    (delegationServiceModule as any).delegationService = null;
    service = new delegationServiceModule.DelegationService();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await new Promise(r => setTimeout(r, 10)); // Allow file locks to release
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const validDelegationParams = {
    delegateAgent: 'agent-1',
    expires: new Date(Date.now() + 100000).toISOString(),
    scope: { type: 'all' as const } as DelegationScope,
    createdBy: 'user-1'
  };

  describe('setDelegation & getDelegation', () => {
    it('sets and retrieves delegation successfully', async () => {
      const result = await service.setDelegation(validDelegationParams);
      expect(result.enabled).toBe(true);
      expect(result.delegateAgent).toBe('agent-1');

      const retrieved = await service.getDelegation();
      expect(retrieved).toEqual(result);
    });

    it('auto-expires delegation if past expiration time', async () => {
      const expiredParams = {
        ...validDelegationParams,
        expires: new Date(Date.now() - 1000).toISOString() // Past
      };
      await service.setDelegation(expiredParams);

      const retrieved = await service.getDelegation();
      expect(retrieved?.enabled).toBe(false);
    });

    it('returns null if no settings file exists', async () => {
      const retrieved = await service.getDelegation();
      expect(retrieved).toBeNull();
    });
  });

  describe('revokeDelegation', () => {
    it('disables active delegation', async () => {
      await service.setDelegation(validDelegationParams);

      const revoked = await service.revokeDelegation();
      expect(revoked).toBe(true);

      const retrieved = await service.getDelegation();
      expect(retrieved?.enabled).toBe(false);
    });

    it('returns false if no delegation exists to revoke', async () => {
      const revoked = await service.revokeDelegation();
      expect(revoked).toBe(false);
    });
  });

  describe('canApprove', () => {
    it('returns true for matching agent and all scope', async () => {
      await service.setDelegation(validDelegationParams);
      const result = await service.canApprove('agent-1', { id: 'task-1' });
      expect(result.allowed).toBe(true);
    });

    it('returns false for non-matching agent', async () => {
      await service.setDelegation(validDelegationParams);
      const result = await service.canApprove('agent-2', { id: 'task-1' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Agent is not the delegate');
    });

    it('returns false if no active delegation', async () => {
      const result = await service.canApprove('agent-1', { id: 'task-1' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No active delegation');
    });

    it('returns false if delegation is expired', async () => {
      await service.setDelegation({
        ...validDelegationParams,
        expires: new Date(Date.now() - 1000).toISOString()
      });
      // The auto-disable happens during loadSettings() if expired, so it might
      // return 'No active delegation' instead of 'Delegation has expired'
      // if the file is loaded and rewritten before the check.
      const result = await service.canApprove('agent-1', { id: 'task-1' });
      expect(result.allowed).toBe(false);
      expect(
        result.reason?.includes('Delegation has expired') ||
        result.reason?.includes('No active delegation')
      ).toBe(true);
    });

    it('returns false for excluded priority', async () => {
      await service.setDelegation({
        ...validDelegationParams,
        excludePriorities: ['urgent'] as TaskPriority[]
      });
      const result = await service.canApprove('agent-1', { id: 'task-1', priority: 'urgent' as TaskPriority });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Priority "urgent" is excluded');
    });

    it('returns false for excluded tag', async () => {
      await service.setDelegation({
        ...validDelegationParams,
        excludeTags: ['finance']
      });
      const result = await service.canApprove('agent-1', { id: 'task-1', tags: ['bug', 'finance'] });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Task has excluded tag: finance');
    });

    it('validates project scope', async () => {
      await service.setDelegation({
        ...validDelegationParams,
        scope: { type: 'project', projectIds: ['proj-1'] }
      });

      const allowed = await service.canApprove('agent-1', { id: 'task-1', project: 'proj-1' });
      expect(allowed.allowed).toBe(true);

      const rejected = await service.canApprove('agent-1', { id: 'task-1', project: 'proj-2' });
      expect(rejected.allowed).toBe(false);
      expect(rejected.reason).toContain('not in delegation scope');

      const noProject = await service.canApprove('agent-1', { id: 'task-1' });
      expect(noProject.allowed).toBe(false);
      expect(noProject.reason).toContain('Task has no project');
    });

    it('validates priority scope', async () => {
      await service.setDelegation({
        ...validDelegationParams,
        scope: { type: 'priority', priorities: ['high'] as TaskPriority[] }
      });

      const allowed = await service.canApprove('agent-1', { id: 'task-1', priority: 'high' as TaskPriority });
      expect(allowed.allowed).toBe(true);

      const rejected = await service.canApprove('agent-1', { id: 'task-1', priority: 'low' as TaskPriority });
      expect(rejected.allowed).toBe(false);
      expect(rejected.reason).toContain('not in delegation scope');

      const noPriority = await service.canApprove('agent-1', { id: 'task-1' });
      expect(noPriority.allowed).toBe(false);
      expect(noPriority.reason).toContain('Task has no priority');
    });
  });

  describe('logApproval & getApprovalLog', () => {
    it('logs approvals and retrieves them', async () => {
      await service.setDelegation(validDelegationParams);

      const approval = await service.logApproval({
        taskId: 'task-1',
        taskTitle: 'Title 1',
        agent: 'agent-1'
      });

      expect(approval.taskId).toBe('task-1');
      expect(approval.delegated).toBe(true);

      const log = await service.getApprovalLog();
      expect(log).toHaveLength(1);
      expect(log[0].taskId).toBe('task-1');
    });

    it('filters approval log by taskId and agent', async () => {
      await service.setDelegation(validDelegationParams);

      await service.logApproval({ taskId: 'task-1', taskTitle: '1', agent: 'agent-1' });
      await service.logApproval({ taskId: 'task-2', taskTitle: '2', agent: 'agent-2' });

      const byTask = await service.getApprovalLog({ taskId: 'task-1' });
      expect(byTask).toHaveLength(1);
      expect(byTask[0].taskId).toBe('task-1');

      const byAgent = await service.getApprovalLog({ agent: 'agent-2' });
      expect(byAgent).toHaveLength(1);
      expect(byAgent[0].agent).toBe('agent-2');
    });

    it('limits approval log results', async () => {
      await service.setDelegation(validDelegationParams);
      await service.logApproval({ taskId: 'task-1', taskTitle: '1', agent: 'agent-1' });
      await service.logApproval({ taskId: 'task-2', taskTitle: '2', agent: 'agent-1' });

      const log = await service.getApprovalLog({ limit: 1 });
      expect(log).toHaveLength(1);
      // It sorts by timestamp desc, so should return the newest
      expect(log[0].taskId).toBe('task-2');
    });

    it('handles concurrent log writing properly', async () => {
      await service.setDelegation(validDelegationParams);

      // Simulate concurrent logs
      const promises = Array.from({ length: 10 }).map((_, i) =>
        service.logApproval({ taskId: `task-${i}`, taskTitle: `Title ${i}`, agent: 'agent-1' })
      );

      await Promise.all(promises);

      // Verify all 10 were saved
      const delegationServiceModule = await import('../services/delegation-service.js');
      const newService = new delegationServiceModule.DelegationService();
      const log = await newService.getApprovalLog();
      expect(log).toHaveLength(10);
    });
  });
});
