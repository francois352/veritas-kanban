import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockFeedbackService = vi.hoisted(() => ({
  list: vi.fn(),
  getAnalytics: vi.fn(),
  listUnresolved: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/feedback-service.js', () => ({
  feedbackService: mockFeedbackService,
}));

import { feedbackRoutes } from '../../routes/feedback.js';

describe('Feedback Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/feedback', feedbackRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/feedback', () => {
    it('returns a list of feedback', async () => {
      mockFeedbackService.list.mockResolvedValue([{ id: 'fb_1' }]);

      const response = await request(app).get('/api/feedback?limit=10&resolved=false');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockFeedbackService.list).toHaveBeenCalledWith({
        taskId: undefined,
        agent: undefined,
        category: undefined,
        sentiment: undefined,
        resolved: false,
        since: undefined,
        until: undefined,
        limit: 10,
      });
    });
  });

  describe('GET /api/feedback/analytics', () => {
    it('returns feedback analytics', async () => {
      mockFeedbackService.getAnalytics.mockResolvedValue({ total: 10, averageRating: 4.5 });

      const response = await request(app).get('/api/feedback/analytics?taskId=task_1');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(10);
      expect(mockFeedbackService.getAnalytics).toHaveBeenCalledWith({
        taskId: 'task_1',
        agent: undefined,
        category: undefined,
        sentiment: undefined,
        since: undefined,
        until: undefined,
      });
    });
  });

  describe('GET /api/feedback/unresolved', () => {
    it('returns a list of unresolved feedback', async () => {
      mockFeedbackService.listUnresolved.mockResolvedValue([{ id: 'fb_1' }]);

      const response = await request(app).get('/api/feedback/unresolved?limit=5');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockFeedbackService.listUnresolved).toHaveBeenCalledWith(5);
    });
  });

  describe('GET /api/feedback/:id', () => {
    it('returns a specific feedback item', async () => {
      mockFeedbackService.get.mockResolvedValue({ id: 'fb_1', rating: 5 });

      const response = await request(app).get('/api/feedback/fb_1');

      expect(response.status).toBe(200);
      expect(response.body.rating).toBe(5);
      expect(mockFeedbackService.get).toHaveBeenCalledWith('fb_1');
    });

    it('returns 404 if feedback is not found', async () => {
      mockFeedbackService.get.mockResolvedValue(null);

      const response = await request(app).get('/api/feedback/fb_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/feedback', () => {
    it('creates a new feedback item', async () => {
      mockFeedbackService.create.mockResolvedValue({ id: 'fb_1', taskId: 'task_1', rating: 5 });

      const response = await request(app).post('/api/feedback').send({
        taskId: 'task_1',
        rating: 5,
        categories: ['quality'],
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('fb_1');
      expect(mockFeedbackService.create).toHaveBeenCalledWith({
        taskId: 'task_1',
        rating: 5,
        categories: ['quality'],
      });
    });

    it('returns 400 for invalid rating', async () => {
      const response = await request(app).post('/api/feedback').send({
        taskId: 'task_1',
        rating: 6, // invalid
      });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/feedback/:id', () => {
    it('updates a feedback item', async () => {
      mockFeedbackService.update.mockResolvedValue({ id: 'fb_1', rating: 4, resolved: true });

      const response = await request(app).put('/api/feedback/fb_1').send({
        rating: 4,
        resolved: true,
      });

      expect(response.status).toBe(200);
      expect(response.body.resolved).toBe(true);
      expect(mockFeedbackService.update).toHaveBeenCalledWith('fb_1', {
        rating: 4,
        resolved: true,
      });
    });

    it('returns 404 if item to update is not found', async () => {
      mockFeedbackService.update.mockResolvedValue(null);

      const response = await request(app).put('/api/feedback/fb_not_found').send({
        rating: 4,
      });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/feedback/:id', () => {
    it('deletes a feedback item', async () => {
      mockFeedbackService.delete.mockResolvedValue(true);

      const response = await request(app).delete('/api/feedback/fb_1');

      expect(response.status).toBe(204);
      expect(mockFeedbackService.delete).toHaveBeenCalledWith('fb_1');
    });

    it('returns 404 if item to delete is not found', async () => {
      mockFeedbackService.delete.mockResolvedValue(false);

      const response = await request(app).delete('/api/feedback/fb_not_found');

      expect(response.status).toBe(404);
    });
  });
});
