import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import driftRoutes from '../../routes/drift.js';
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

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/drift', driftRoutes);
app.use(errorHandler);

describe('Drift Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/drift/alerts/:id/acknowledge', async () => {
      mockDriftService.acknowledgeAlert.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/drift/alerts/123/acknowledge')
          .set('X-Forwarded-For', '192.168.1.117');
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on POST /api/drift/baselines/reset', async () => {
      mockDriftService.resetBaselines.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/drift/baselines/reset')
          .set('X-Forwarded-For', '192.168.1.118')
          .send({ agentId: 'claude' });
      }

      expect(res?.status).toBe(429);
    });

    it('should enforce writeRateLimit on POST /api/drift/analyze', async () => {
      mockDriftService.analyzeAgent.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/drift/analyze')
          .set('X-Forwarded-For', '192.168.1.119')
          .send({ agentId: 'claude' });
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long agentId in POST /api/drift/baselines/reset', async () => {
      const longAgentId = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/drift/baselines/reset')
        .send({
          agentId: longAgentId,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject overly long agentId in POST /api/drift/analyze', async () => {
      const longAgentId = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/drift/analyze')
        .send({
          agentId: longAgentId,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
