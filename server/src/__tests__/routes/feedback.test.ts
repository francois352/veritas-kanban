import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { feedbackRoutes } from '../../routes/feedback.js';
import { errorHandler } from '../../middleware/error-handler.js';

const mockFeedbackService = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/feedback-service.js', () => ({
  feedbackService: mockFeedbackService,
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/feedback', feedbackRoutes);
app.use(errorHandler);

describe('Feedback Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/feedback', async () => {
      mockFeedbackService.create.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/feedback')
          .set('X-Forwarded-For', '192.168.1.109')
          .send({
            taskId: 'task',
            rating: 5,
          });
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on PUT /api/feedback/:id', async () => {
      mockFeedbackService.update.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .put('/api/feedback/123')
          .set('X-Forwarded-For', '192.168.1.110')
          .send({ rating: 4 });
      }

      expect(res?.status).toBe(429);
    });

    it('should enforce writeRateLimit on DELETE /api/feedback/:id', async () => {
      mockFeedbackService.delete.mockResolvedValue(true);

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .delete('/api/feedback/123')
          .set('X-Forwarded-For', '192.168.1.111');
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long taskId and agent in POST', async () => {
      const longString = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/feedback')
        .send({
          taskId: longString,
          agent: longString,
          rating: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
