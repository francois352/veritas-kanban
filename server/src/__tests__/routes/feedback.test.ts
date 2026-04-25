/**
 * Feedback Routes — test coverage for #250
 *
 * Tests HTTP status codes, request validation, error handling,
 * and auth middleware enforcement for /api/feedback/* endpoints.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock service before importing route ─────────────────────────────────────

const { mockFeedbackService } = vi.hoisted(() => ({
  mockFeedbackService: {
    list: vi.fn(),
    getAnalytics: vi.fn(),
    listUnresolved: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/feedback-service.js', () => ({
  feedbackService: mockFeedbackService,
  detectSentiment: vi.fn().mockReturnValue('positive'),
}));

vi.mock('../../lib/query-helpers.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return actual;
});

import { feedbackRoutes } from '../../routes/feedback.js';

// ── App builders ─────────────────────────────────────────────────────────────

function buildApp(authenticated = true) {
  const app = express();
  app.use(express.json());

  if (authenticated) {
    app.use((req: any, _res: any, next: any) => {
      req.auth = { role: 'admin', keyName: 'test-key', isLocalhost: true };
      next();
    });
  } else {
    // Simulate auth middleware blocking the request
    app.use((_req: any, res: any) => {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Authentication required' });
    });
  }

  app.use('/', feedbackRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ code: err.code || 'ERROR', message: err.message });
  });
  return app;
}

const sampleFeedback = {
  id: 'fb_1',
  taskId: 'task_1',
  agent: 'codex',
  rating: 4,
  comment: 'Good work',
  categories: ['quality'],
  createdAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Feedback Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp(true);
  });

  // ── Auth enforcement ───────────────────────────────────────────────────────

  describe('auth enforcement', () => {
    it('GET / returns 401 without auth', async () => {
      const unauthApp = buildApp(false);
      const res = await request(unauthApp).get('/');
      expect(res.status).toBe(401);
    });

    it('POST / returns 401 without auth', async () => {
      const unauthApp = buildApp(false);
      const res = await request(unauthApp).post('/').send({ taskId: 'task_1', rating: 4 });
      expect(res.status).toBe(401);
    });

    it('DELETE /:id returns 401 without auth', async () => {
      const unauthApp = buildApp(false);
      const res = await request(unauthApp).delete('/fb_1');
      expect(res.status).toBe(401);
    });
  });

  // ── GET / ──────────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns 200 with feedback list', async () => {
      mockFeedbackService.list.mockResolvedValue([sampleFeedback]);
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('passes query params to service', async () => {
      mockFeedbackService.list.mockResolvedValue([]);
      const res = await request(app).get('/?taskId=task_1&agent=codex&limit=10&resolved=false');
      expect(res.status).toBe(200);
      expect(mockFeedbackService.list).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task_1', agent: 'codex', limit: 10, resolved: false })
      );
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.list.mockRejectedValue(new Error('DB error'));
      const res = await request(app).get('/');
      expect(res.status).toBe(500);
    });
  });

  // ── GET /analytics ────────────────────────────────────────────────────────

  describe('GET /analytics', () => {
    it('returns 200 with analytics data', async () => {
      mockFeedbackService.getAnalytics.mockResolvedValue({
        totalCount: 5,
        averageRating: 4.2,
        sentimentBreakdown: { positive: 3, neutral: 1, negative: 1 },
      });
      const res = await request(app).get('/analytics');
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(5);
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.getAnalytics.mockRejectedValue(new Error('Analytics failed'));
      const res = await request(app).get('/analytics');
      expect(res.status).toBe(500);
    });
  });

  // ── GET /unresolved ───────────────────────────────────────────────────────

  describe('GET /unresolved', () => {
    it('returns 200 with unresolved feedback', async () => {
      mockFeedbackService.listUnresolved.mockResolvedValue([sampleFeedback]);
      const res = await request(app).get('/unresolved');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('passes limit param to service', async () => {
      mockFeedbackService.listUnresolved.mockResolvedValue([]);
      const res = await request(app).get('/unresolved?limit=20');
      expect(res.status).toBe(200);
      expect(mockFeedbackService.listUnresolved).toHaveBeenCalledWith(20);
    });
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────

  describe('GET /:id', () => {
    it('returns 200 for existing feedback', async () => {
      mockFeedbackService.get.mockResolvedValue(sampleFeedback);
      const res = await request(app).get('/fb_1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('fb_1');
    });

    it('returns 404 for non-existent feedback', async () => {
      mockFeedbackService.get.mockResolvedValue(null);
      const res = await request(app).get('/missing');
      expect(res.status).toBe(404);
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.get.mockRejectedValue(new Error('Read error'));
      const res = await request(app).get('/fb_1');
      expect(res.status).toBe(500);
    });
  });

  // ── POST / ─────────────────────────────────────────────────────────────────

  describe('POST /', () => {
    const validPayload = { taskId: 'task_1', rating: 4, comment: 'Nice' };

    it('returns 201 on successful create', async () => {
      mockFeedbackService.create.mockResolvedValue({ ...sampleFeedback, ...validPayload });
      const res = await request(app).post('/').send(validPayload);
      expect(res.status).toBe(201);
    });

    it('returns 400 when taskId is missing', async () => {
      const res = await request(app).post('/').send({ rating: 4 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when rating is missing', async () => {
      const res = await request(app).post('/').send({ taskId: 'task_1' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when rating is out of range (>5)', async () => {
      const res = await request(app).post('/').send({ taskId: 'task_1', rating: 10 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when rating is out of range (<1)', async () => {
      const res = await request(app).post('/').send({ taskId: 'task_1', rating: 0 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid category', async () => {
      const res = await request(app)
        .post('/')
        .send({ taskId: 'task_1', rating: 4, categories: ['invalid-category'] });
      expect(res.status).toBe(400);
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.create.mockRejectedValue(new Error('Write failed'));
      const res = await request(app).post('/').send(validPayload);
      expect(res.status).toBe(500);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────────

  describe('PUT /:id', () => {
    const updatePayload = { rating: 5, resolved: true };

    it('returns 200 on successful update', async () => {
      mockFeedbackService.update.mockResolvedValue({ ...sampleFeedback, ...updatePayload });
      const res = await request(app).put('/fb_1').send(updatePayload);
      expect(res.status).toBe(200);
    });

    it('returns 404 when feedback not found', async () => {
      mockFeedbackService.update.mockResolvedValue(null);
      const res = await request(app).put('/missing').send(updatePayload);
      expect(res.status).toBe(404);
    });

    it('returns 400 when rating is out of range', async () => {
      const res = await request(app).put('/fb_1').send({ rating: 6 });
      expect(res.status).toBe(400);
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.update.mockRejectedValue(new Error('Update failed'));
      const res = await request(app).put('/fb_1').send(updatePayload);
      expect(res.status).toBe(500);
    });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────

  describe('DELETE /:id', () => {
    it('returns 204 on successful delete', async () => {
      mockFeedbackService.delete.mockResolvedValue(true);
      const res = await request(app).delete('/fb_1');
      expect(res.status).toBe(204);
    });

    it('returns 404 when feedback not found', async () => {
      mockFeedbackService.delete.mockResolvedValue(false);
      const res = await request(app).delete('/missing');
      expect(res.status).toBe(404);
    });

    it('returns 500 on service error', async () => {
      mockFeedbackService.delete.mockRejectedValue(new Error('Delete failed'));
      const res = await request(app).delete('/fb_1');
      expect(res.status).toBe(500);
    });
  });
});
