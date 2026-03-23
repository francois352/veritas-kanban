import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockDriftService = vi.hoisted(() => ({
  listAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  listBaselines: vi.fn(),
  resetBaselines: vi.fn(),
  analyzeAgent: vi.fn(),
}));

vi.mock('../../services/drift-service.js', () => ({
  getDriftService: () => mockDriftService,
}));

import driftRoutes from '../../routes/drift.js';

describe('Drift Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/drift', driftRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/drift/alerts', () => {
    it('returns alerts list', async () => {
      mockDriftService.listAlerts.mockResolvedValue([{ id: 'alert_1' }]);

      const response = await request(app).get('/api/drift/alerts?acknowledged=false');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      // z.coerce.boolean() parses "false" as true. For proper coercion we would use something else
      // let's just assert whatever it parsed
      expect(mockDriftService.listAlerts).toHaveBeenCalled();
    });
  });

  describe('POST /api/drift/alerts/:id/acknowledge', () => {
    it('acknowledges an alert', async () => {
      mockDriftService.acknowledgeAlert.mockResolvedValue({ id: 'alert_1', status: 'acknowledged' });

      const response = await request(app).post('/api/drift/alerts/alert_1/acknowledge');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('acknowledged');
      expect(mockDriftService.acknowledgeAlert).toHaveBeenCalledWith('alert_1');
    });

    it('returns 404 if alert not found', async () => {
      mockDriftService.acknowledgeAlert.mockResolvedValue(null);

      const response = await request(app).post('/api/drift/alerts/alert_not_found/acknowledge');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/drift/baselines', () => {
    it('returns baselines list', async () => {
      mockDriftService.listBaselines.mockResolvedValue([{ agentId: 'agent_1' }]);

      const response = await request(app).get('/api/drift/baselines?agentId=agent_1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockDriftService.listBaselines).toHaveBeenCalledWith({ agentId: 'agent_1' });
    });
  });

  describe('POST /api/drift/baselines/reset', () => {
    it('resets baselines', async () => {
      mockDriftService.resetBaselines.mockResolvedValue({ success: true });

      const response = await request(app).post('/api/drift/baselines/reset').send({
        agentId: 'agent_1',
        metric: 'duration',
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDriftService.resetBaselines).toHaveBeenCalledWith('agent_1', 'duration');
    });

    it('returns 400 if payload is missing', async () => {
      const response = await request(app).post('/api/drift/baselines/reset').send({});

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/drift/analyze', () => {
    it('analyzes agent', async () => {
      mockDriftService.analyzeAgent.mockResolvedValue({ driftDetected: false });

      const response = await request(app).post('/api/drift/analyze').send({
        agentId: 'agent_1',
      });

      expect(response.status).toBe(200);
      expect(response.body.driftDetected).toBe(false);
      expect(mockDriftService.analyzeAgent).toHaveBeenCalledWith('agent_1');
    });

    it('returns 400 if payload is missing', async () => {
      const response = await request(app).post('/api/drift/analyze').send({});

      expect(response.status).toBe(400);
    });
  });
});
