import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockScoringService = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  evaluate: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock('../../services/scoring-service.js', () => ({
  scoringService: mockScoringService,
}));

import { scoringRoutes } from '../../routes/scoring.js';

describe('Scoring Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/scoring', scoringRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/scoring/profiles', () => {
    it('returns a list of profiles', async () => {
      mockScoringService.listProfiles.mockResolvedValue([{ id: 'profile_1' }]);

      const response = await request(app).get('/api/scoring/profiles');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockScoringService.listProfiles).toHaveBeenCalled();
    });
  });

  describe('GET /api/scoring/profiles/:id', () => {
    it('returns a specific profile', async () => {
      mockScoringService.getProfile.mockResolvedValue({ id: 'profile_1' });

      const response = await request(app).get('/api/scoring/profiles/profile_1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('profile_1');
      expect(mockScoringService.getProfile).toHaveBeenCalledWith('profile_1');
    });

    it('returns 404 if profile not found', async () => {
      mockScoringService.getProfile.mockResolvedValue(null);

      const response = await request(app).get('/api/scoring/profiles/profile_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/scoring/profiles', () => {
    it('creates a new profile', async () => {
      const profileInput = {
        name: 'test-profile',
        scorers: [
          {
            id: 'scorer_1',
            name: 'test-scorer',
            type: 'RegexMatch',
            weight: 1,
            pattern: 'test',
          },
        ],
        compositeMethod: 'weightedAvg',
      };
      mockScoringService.createProfile.mockResolvedValue({ id: 'profile_1', ...profileInput });

      const response = await request(app).post('/api/scoring/profiles').send(profileInput);

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('profile_1');
      expect(mockScoringService.createProfile).toHaveBeenCalledWith(profileInput);
    });

    it('returns 400 for invalid input', async () => {
      const response = await request(app).post('/api/scoring/profiles').send({
        name: 'test-profile',
        // missing scorers and compositeMethod
      });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/scoring/profiles/:id', () => {
    it('updates a profile', async () => {
      mockScoringService.updateProfile.mockResolvedValue({ id: 'profile_1', name: 'updated' });

      const response = await request(app).put('/api/scoring/profiles/profile_1').send({
        name: 'updated',
      });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('updated');
      expect(mockScoringService.updateProfile).toHaveBeenCalledWith('profile_1', {
        name: 'updated',
      });
    });

    it('returns 404 if profile to update is not found', async () => {
      mockScoringService.updateProfile.mockResolvedValue(null);

      const response = await request(app).put('/api/scoring/profiles/profile_not_found').send({
        name: 'updated',
      });

      expect(response.status).toBe(404);
    });

    it('returns 400 if updating a built-in profile throws', async () => {
      mockScoringService.updateProfile.mockRejectedValue(new Error('Built-in profiles cannot be modified'));

      const response = await request(app).put('/api/scoring/profiles/profile_1').send({
        name: 'updated',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/scoring/profiles/:id', () => {
    it('deletes a profile', async () => {
      mockScoringService.deleteProfile.mockResolvedValue(true);

      const response = await request(app).delete('/api/scoring/profiles/profile_1');

      expect(response.status).toBe(204);
      expect(mockScoringService.deleteProfile).toHaveBeenCalledWith('profile_1');
    });

    it('returns 404 if profile to delete is not found', async () => {
      mockScoringService.deleteProfile.mockResolvedValue(false);

      const response = await request(app).delete('/api/scoring/profiles/profile_not_found');

      expect(response.status).toBe(404);
    });

    it('returns 400 if deleting a built-in profile throws', async () => {
      mockScoringService.deleteProfile.mockRejectedValue(new Error('Built-in profiles cannot be deleted'));

      const response = await request(app).delete('/api/scoring/profiles/profile_1');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/scoring/evaluate', () => {
    it('evaluates based on profile', async () => {
      mockScoringService.evaluate.mockResolvedValue({ score: 95 });

      const response = await request(app).post('/api/scoring/evaluate').send({
        profileId: 'profile_1',
        output: 'test output',
      });

      expect(response.status).toBe(201);
      expect(response.body.score).toBe(95);
      expect(mockScoringService.evaluate).toHaveBeenCalledWith({
        profileId: 'profile_1',
        output: 'test output',
      });
    });

    it('returns 400 for missing output', async () => {
      const response = await request(app).post('/api/scoring/evaluate').send({
        profileId: 'profile_1',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/scoring/history', () => {
    it('returns history', async () => {
      mockScoringService.getHistory.mockResolvedValue([{ id: 'history_1' }]);

      const response = await request(app).get('/api/scoring/history?profileId=profile_1&limit=10');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockScoringService.getHistory).toHaveBeenCalledWith({
        profileId: 'profile_1',
        agent: undefined,
        taskId: undefined,
        limit: 10,
      });
    });
  });
});
