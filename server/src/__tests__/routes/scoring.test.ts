import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { scoringRoutes } from '../../routes/scoring.js';
import { errorHandler } from '../../middleware/error-handler.js';

const mockScoringService = vi.hoisted(() => ({
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock('../../services/scoring-service.js', () => ({
  scoringService: mockScoringService,
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/scoring', scoringRoutes);
app.use(errorHandler);

describe('Scoring Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/scoring/profiles', async () => {
      mockScoringService.createProfile.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/scoring/profiles')
          .set('X-Forwarded-For', '192.168.1.115')
          .send({
            name: 'Profile',
            scorers: [{ type: 'CustomExpression', id: '1', name: '1', expression: '1', weight: 1 }],
            compositeMethod: 'minimum'
          });
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on POST /api/scoring/evaluate', async () => {
      mockScoringService.evaluate.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/scoring/evaluate')
          .set('X-Forwarded-For', '192.168.1.116')
          .send({ profileId: '123', output: 'result' });
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long name in POST /api/scoring/profiles', async () => {
      const longName = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/scoring/profiles')
        .send({
          name: longName,
          scorers: [{ type: 'CustomExpression', id: '1', name: '1', expression: '1', weight: 1 }],
          compositeMethod: 'minimum'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject overly long output in POST /api/scoring/evaluate', async () => {
      const longOutput = 'A'.repeat(10001);
      const res = await request(app)
        .post('/api/scoring/evaluate')
        .send({
          profileId: '123',
          output: longOutput
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
