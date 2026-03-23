import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkflowRunService } from '../services/workflow-run-service.js';
import type { WorkflowDefinition } from '../types/workflow.js';

vi.mock('../services/workflow-step-executor.js', () => {
  return {
    WorkflowStepExecutor: class MockExecutor {
      async executeStep() {
        return { output: 'step-output', outputPath: 'path/to/output' };
      }
    }
  };
});

vi.mock('../services/broadcast-service.js', () => ({
  broadcastWorkflowStatus: vi.fn(),
}));

vi.mock('../services/task-service.js', () => ({
  getTaskService: vi.fn().mockReturnValue({
    getTask: vi.fn().mockResolvedValue({ id: 'task-1', title: 'Test Task' }),
  }),
}));

vi.mock('../middleware/workflow-auth.js', () => ({
  checkWorkflowPermission: vi.fn().mockResolvedValue(true),
}));

describe('WorkflowRunService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: WorkflowRunService;
  let workflowService: any;

  const validWorkflow: WorkflowDefinition = {
    id: 'test-workflow',
    name: 'Test Workflow',
    version: '1.0',
    description: 'A test workflow',
    agents: [{ id: 'agent-1', name: 'Agent 1', model: 'gpt-4o' }],
    steps: [
      { id: 'step-1', type: 'agent', agent: 'agent-1', instruction: 'Do something' },
    ],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-workflow-run-'));
    process.chdir(tempDir);
    process.env.DATA_DIR = tempDir;

    // Clear the singleton state before every test
    const workflowRunServiceInstance = await import('../services/workflow-run-service.js');
    (workflowRunServiceInstance as any).workflowRunServiceInstance = null;

    // We need workflow service to load the workflow definition during runs
    const workflowServiceModule = await import('../services/workflow-service.js');
    (workflowServiceModule as any).workflowServiceInstance = null;

    // The singleton path utils will create things using process.cwd() or process.env.DATA_DIR
    // Let's ensure they are created explicitly.
    const runDir = join(tempDir, 'workflow-runs');
    const workflowsDir = join(tempDir, 'workflows');

    await mkdir(runDir, { recursive: true });
    await mkdir(workflowsDir, { recursive: true });

    workflowService = new workflowServiceModule.WorkflowService(workflowsDir);
    workflowService.clearCache();
    await workflowService.saveWorkflow(validWorkflow);

    // the workflow run service depends on getWorkflowService singleton internally
    // so we must override it BEFORE instantiating WorkflowRunService

    // We can mock getWorkflowService so the run service uses our scoped one
    vi.doMock('../services/workflow-service.js', () => ({
      getWorkflowService: () => workflowService,
      WorkflowService: workflowServiceModule.WorkflowService
    }));

    service = new WorkflowRunService(runDir);
    // Explicitly inject the workflow service just to be sure
    (service as any).workflowService = workflowService;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env.DATA_DIR;
    await new Promise(resolve => setTimeout(resolve, 100)); // allow async execution to finish and close file handles
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
    workflowService.clearCache();
  });

  describe('startRun', () => {
    it('starts a new workflow run successfully', async () => {
      const run = await service.startRun('test-workflow', 'task-1');

      expect(run).toBeDefined();
      expect(run.workflowId).toBe('test-workflow');
      expect(run.taskId).toBe('task-1');
      expect(run.status).toBe('running');
      expect(run.context.task).toEqual({ id: 'task-1', title: 'Test Task' });

      // Allow a small delay for execution logic to save
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify it was saved to disk
      const loadedRun = await service.getRun(run.id);
      expect(loadedRun).toBeDefined();
      expect(loadedRun?.id).toBe(run.id);
    });

    it('throws if workflow does not exist', async () => {
      await expect(service.startRun('non-existent')).rejects.toThrow(/Workflow non-existent not found/);
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const run = await service.getRun('run_1234567890_abcdef');
      expect(run).toBeNull();
    });

    it('throws validation error for invalid run ID', async () => {
      await expect(service.getRun('invalid-id')).rejects.toThrow(/Run ID format is invalid/);
    });
  });

  describe('listRuns & listRunsMetadata', () => {
    it('lists all runs', async () => {
      const run1 = await service.startRun('test-workflow');
      const run2 = await service.startRun('test-workflow', 'task-1');

      // Allow some time for execution to finish
      await new Promise(resolve => setTimeout(resolve, 50));

      const runs = await service.listRuns();
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.map(r => r.id)).toEqual(expect.arrayContaining([run1.id, run2.id]));
    });

    it('filters runs by taskId', async () => {
      await service.startRun('test-workflow');
      const run2 = await service.startRun('test-workflow', 'task-1');

      await new Promise(resolve => setTimeout(resolve, 50));

      const runs = await service.listRuns({ taskId: 'task-1' });
      // Might pick up runs from other tests, so we filter out
      const matchingRuns = runs.filter(r => r.id === run2.id);
      expect(matchingRuns).toHaveLength(1);
    });

    it('returns metadata only', async () => {
      const run = await service.startRun('test-workflow');

      await new Promise(resolve => setTimeout(resolve, 50));

      const metadata = await service.listRunsMetadata();
      const runMeta = metadata.find(m => m.id === run.id);
      expect(runMeta).toBeDefined();
      expect(runMeta).toHaveProperty('id');
      expect(runMeta).toHaveProperty('status');
      expect(runMeta).not.toHaveProperty('context');
    });
  });

  describe('resumeRun', () => {
    it('throws if run not found', async () => {
      await expect(service.resumeRun('run_1234567890_abcdef')).rejects.toThrow(/Run run_1234567890_abcdef not found/);
    });

    it('throws if run is not blocked', async () => {
      const run = await service.startRun('test-workflow');
      await new Promise(resolve => setTimeout(resolve, 50));

      await expect(service.resumeRun(run.id)).rejects.toThrow(/is not blocked/);
    });
  });

  describe('getStats', () => {
    it('calculates stats for visible runs', async () => {
      await service.startRun('test-workflow');
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = await service.getStats('24h', 'user-1');
      expect(stats.totalWorkflows).toBeGreaterThanOrEqual(1);
      expect(stats.completedRuns + stats.failedRuns + stats.activeRuns).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Concurrency & Limits', () => {
      it('enforces maximum concurrent runs limit', async () => {
          // Mock the executeRun to not complete immediately so we can queue up multiple
          const serviceAny = service as any;
          const originalExecuteRun = serviceAny.executeRun;

          // The startRun method doesn't await executeRun. It increments the counter inside executeRun.
          // Since executeRun is called synchronously but executes asynchronously, if we mock it out
          // completely, the activeRunCount inside workflow-run-service.js might not increment as expected,
          // or we just need to hit the limit by actually letting it enter executeRun but blocking.

          let resolveExecution: any;
          const blockingPromise = new Promise(r => resolveExecution = r);

          serviceAny.executeRun = async function(run: any, workflow: any) {
             // Let it execute the real thing but we mock stepExecutor to block
             return originalExecuteRun.call(this, run, workflow);
          };

          // Mock stepExecutor to block
          serviceAny.stepExecutor.executeStep = vi.fn().mockImplementation(() => blockingPromise);

          const promises = [];
          for (let i = 0; i < 10; i++) {
              promises.push(service.startRun('test-workflow'));
          }
          await Promise.all(promises);

          // Wait a tick for the async executeRun calls to increment the internal counter
          await new Promise(resolve => setTimeout(resolve, 50));

          await expect(service.startRun('test-workflow')).rejects.toThrow(/Maximum concurrent workflow runs/);

          // cleanup
          resolveExecution({ output: 'done', outputPath: 'done' });
          serviceAny.executeRun = originalExecuteRun;
      });
  });
});
