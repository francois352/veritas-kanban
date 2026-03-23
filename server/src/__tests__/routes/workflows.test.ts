import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockWorkflowService = vi.hoisted(() => ({
  listWorkflowsMetadata: vi.fn(),
  loadWorkflow: vi.fn(),
  saveWorkflow: vi.fn(),
  saveACL: vi.fn(),
  auditChange: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

vi.mock('../../services/workflow-service.js', () => ({
  getWorkflowService: () => mockWorkflowService,
}));

const mockWorkflowRunService = vi.hoisted(() => ({
  startRun: vi.fn(),
  listRunsMetadata: vi.fn(),
  getStats: vi.fn(),
  getRun: vi.fn(),
  resumeRun: vi.fn(),
}));

vi.mock('../../services/workflow-run-service.js', () => ({
  getWorkflowRunService: () => mockWorkflowRunService,
}));

vi.mock('../../middleware/workflow-auth.js', () => ({
  checkWorkflowPermission: vi.fn().mockResolvedValue(true),
  assertWorkflowPermission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/auth.js', () => ({
  // Dummy authorize middleware
  authorize: () => (req: any, res: any, next: any) => {
    req.auth = { keyName: 'admin-user' };
    next();
  },
  // Ensure we set req.auth for all routes
  authenticate: (req: any, res: any, next: any) => {
    req.auth = { keyName: 'admin-user' };
    next();
  },
}));

import { workflowRoutes } from '../../routes/workflows.js';

describe('Workflow Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    // Apply dummy auth so req.auth exists
    app.use((req: any, res, next) => {
      req.auth = { keyName: 'admin-user' };
      next();
    });
    app.use('/api/workflows', workflowRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/workflows', () => {
    it('returns a list of workflows', async () => {
      mockWorkflowService.listWorkflowsMetadata.mockResolvedValue([{ id: 'wf_1' }]);

      const response = await request(app).get('/api/workflows');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('GET /api/workflows/:id', () => {
    it('returns a specific workflow', async () => {
      mockWorkflowService.loadWorkflow.mockResolvedValue({ id: 'wf_1' });

      const response = await request(app).get('/api/workflows/wf_1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('wf_1');
    });

    it('returns 404 if not found', async () => {
      mockWorkflowService.loadWorkflow.mockResolvedValue(null);

      const response = await request(app).get('/api/workflows/wf_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/workflows', () => {
    it('creates a workflow', async () => {
      const wf = {
        id: 'wf_1',
        name: 'test workflow',
        version: 1,
        description: 'test',
        agents: ['agent_1'],
        steps: [{ id: 'step_1', type: 'task' }],
      };

      const response = await request(app).post('/api/workflows').send(wf);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(mockWorkflowService.saveWorkflow).toHaveBeenCalled();
      expect(mockWorkflowService.saveACL).toHaveBeenCalled();
    });

    it('returns 400 for invalid workflow', async () => {
      const response = await request(app).post('/api/workflows').send({});

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/workflows/:id', () => {
    it('updates a workflow', async () => {
      const wf = {
        id: 'wf_1',
        name: 'updated workflow',
        version: 1,
        description: 'updated',
        agents: ['agent_1'],
        steps: [{ id: 'step_1', type: 'task' }],
      };

      mockWorkflowService.loadWorkflow.mockResolvedValue({ id: 'wf_1', version: 1, name: 'old', description: 'old desc', agents: [], steps: [] });

      const response = await request(app).put('/api/workflows/wf_1').send(wf);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.version).toBe(2);
      expect(mockWorkflowService.saveWorkflow).toHaveBeenCalled();
    });

    it('returns 400 if ID mismatches', async () => {
      const wf = {
        id: 'wf_2',
        name: 'updated workflow',
        version: 1,
        description: 'updated',
        agents: [],
        steps: [{ id: 'step_1', type: 'task' }],
      };

      const response = await request(app).put('/api/workflows/wf_1').send(wf);

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/workflows/:id', () => {
    it('deletes a workflow', async () => {
      mockWorkflowService.deleteWorkflow.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/workflows/wf_1');

      expect(response.status).toBe(204);
      expect(mockWorkflowService.deleteWorkflow).toHaveBeenCalledWith('wf_1');
    });
  });

  describe('POST /api/workflows/:id/runs', () => {
    it('starts a workflow run', async () => {
      mockWorkflowRunService.startRun.mockResolvedValue({ id: 'run_1', workflowVersion: 1 });

      const response = await request(app).post('/api/workflows/wf_1/runs').send({ taskId: 'task_1' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('run_1');
    });
  });

  describe('GET /api/workflows/runs/active', () => {
    it('gets active runs', async () => {
      mockWorkflowRunService.listRunsMetadata.mockResolvedValue([{ id: 'run_1', workflowId: 'wf_1' }]);

      const response = await request(app).get('/api/workflows/runs/active');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockWorkflowRunService.listRunsMetadata).toHaveBeenCalledWith({ status: 'running' });
    });
  });

  describe('GET /api/workflows/runs/stats', () => {
    it('gets stats', async () => {
      mockWorkflowRunService.getStats.mockResolvedValue({ totalRuns: 10 });

      const response = await request(app).get('/api/workflows/runs/stats?period=7d');

      expect(response.status).toBe(200);
      expect(response.body.totalRuns).toBe(10);
    });

    it('returns 400 for invalid period', async () => {
      const response = await request(app).get('/api/workflows/runs/stats?period=invalid');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/workflows/runs', () => {
    it('gets all runs', async () => {
      mockWorkflowRunService.listRunsMetadata.mockResolvedValue([{ id: 'run_1', workflowId: 'wf_1' }]);

      const response = await request(app).get('/api/workflows/runs?status=completed');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });
  });

  describe('GET /api/workflows/runs/:id', () => {
    it('gets a specific run', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({ id: 'run_1', workflowId: 'wf_1' });

      const response = await request(app).get('/api/workflows/runs/run_1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('run_1');
    });

    it('returns 404 if run not found', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(null);

      const response = await request(app).get('/api/workflows/runs/run_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/workflows/runs/:id/resume', () => {
    it('resumes a blocked run', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({ id: 'run_1', workflowId: 'wf_1', status: 'blocked' });
      mockWorkflowRunService.resumeRun.mockResolvedValue({ id: 'run_1', status: 'running' });

      const response = await request(app).post('/api/workflows/runs/run_1/resume').send({});

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('running');
    });

    it('returns 400 if run is not blocked', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({ id: 'run_1', workflowId: 'wf_1', status: 'running' });

      const response = await request(app).post('/api/workflows/runs/run_1/resume').send({});

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/workflows/runs/:runId/steps/:stepId/approve', () => {
    it('approves a gate step', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({
        id: 'run_1',
        workflowId: 'wf_1',
        steps: [{ stepId: 'step_1', status: 'failed' }],
      });
      mockWorkflowService.loadWorkflow.mockResolvedValue({
        id: 'wf_1',
        steps: [{ id: 'step_1', type: 'gate' }],
      });
      mockWorkflowRunService.resumeRun.mockResolvedValue({ id: 'run_1', status: 'running' });

      const response = await request(app).post('/api/workflows/runs/run_1/steps/step_1/approve');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('running');
    });

    it('returns 404 if step not found', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({
        id: 'run_1',
        workflowId: 'wf_1',
        steps: [],
      });

      const response = await request(app).post('/api/workflows/runs/run_1/steps/step_1/approve');

      expect(response.status).toBe(404);
    });

    it('returns 400 if not a gate step', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({
        id: 'run_1',
        workflowId: 'wf_1',
        steps: [{ stepId: 'step_1', status: 'failed' }],
      });
      mockWorkflowService.loadWorkflow.mockResolvedValue({
        id: 'wf_1',
        steps: [{ id: 'step_1', type: 'task' }],
      });

      const response = await request(app).post('/api/workflows/runs/run_1/steps/step_1/approve');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/workflows/runs/:runId/steps/:stepId/reject', () => {
    it('rejects a gate step', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({
        id: 'run_1',
        workflowId: 'wf_1',
        steps: [{ stepId: 'step_1', status: 'failed' }],
      });
      mockWorkflowService.loadWorkflow.mockResolvedValue({
        id: 'wf_1',
        steps: [{ id: 'step_1', type: 'gate' }],
      });

      const response = await request(app).post('/api/workflows/runs/run_1/steps/step_1/reject');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('failed');
      expect(response.body.error).toContain('rejected');
    });
  });

  describe('GET /api/workflows/runs/:runId/steps/:stepId/status', () => {
    it('returns step status', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue({
        id: 'run_1',
        workflowId: 'wf_1',
        steps: [{ stepId: 'step_1', status: 'completed' }],
      });

      const response = await request(app).get('/api/workflows/runs/run_1/steps/step_1/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
    });
  });
});
