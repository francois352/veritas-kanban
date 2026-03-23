import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectSentiment, FeedbackService } from '../services/feedback-service.js';

describe('FeedbackService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: FeedbackService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-feedback-'));
    process.chdir(tempDir);

    // FeedbackService uses process.cwd() at initialization to resolve its feedbackDir
    // We instantiate it fresh so it picks up the temp directory
    vi.resetModules();
    const { FeedbackService: FreshService } = await import('../services/feedback-service.js');
    service = new FreshService();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Sentiment Analysis', () => {
    it('detects positive sentiment', () => {
      expect(detectSentiment('This agent did a great job and was very fast!')).toBe('positive');
      expect(detectSentiment('Excellent output, perfect formatting.')).toBe('positive');
    });

    it('detects negative sentiment', () => {
      expect(detectSentiment('Terrible result, complete failure.')).toBe('negative');
      expect(detectSentiment('The code is broken and does not work.')).toBe('negative');
    });

    it('detects neutral sentiment', () => {
      expect(detectSentiment('The task is complete.')).toBe('neutral');
      expect(detectSentiment('I reviewed the output.')).toBe('neutral');
    });
  });

  describe('CRUD Operations', () => {
    it('creates and gets feedback', async () => {
      const feedback = await service.create({
        taskId: 'TASK-1',
        agent: 'coder-agent',
        rating: 5,
        comment: 'Great work!',
        categories: ['quality', 'performance'],
      });

      expect(feedback.id).toBeDefined();
      expect(feedback.taskId).toBe('TASK-1');
      expect(feedback.agent).toBe('coder-agent');
      expect(feedback.rating).toBe(5);
      expect(feedback.comment).toBe('Great work!');
      expect(feedback.sentiment).toBe('positive');

      const retrieved = await service.get(feedback.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(feedback.id);
      expect(retrieved?.taskId).toBe('TASK-1');
      expect(retrieved?.rating).toBe(5);
    });

    it('lists feedback with filters', async () => {
      await service.create({
        taskId: 'TASK-1',
        agent: 'agent-A',
        rating: 5,
        comment: 'Perfect',
      });
      await service.create({
        taskId: 'TASK-2',
        agent: 'agent-B',
        rating: 1,
        comment: 'Terrible',
      });

      const all = await service.list();
      expect(all).toHaveLength(2);

      const byAgent = await service.list({ agent: 'agent-A' });
      expect(byAgent).toHaveLength(1);
      expect(byAgent[0]?.agent).toBe('agent-A');

      const bySentiment = await service.list({ sentiment: 'negative' });
      expect(bySentiment).toHaveLength(1);
      expect(bySentiment[0]?.comment).toBe('Terrible');
    });
  });

  describe('Analytics', () => {
    it('calculates average rating and rating distributions', async () => {
      await service.create({ taskId: 'T-1', rating: 5, agent: 'A', comment: 'excellent' }); // pos
      await service.create({ taskId: 'T-2', rating: 4, agent: 'A', comment: 'good' });      // pos
      await service.create({ taskId: 'T-3', rating: 1, agent: 'B', comment: 'terrible' });  // neg

      const analytics = await service.getAnalytics();

      expect(analytics.totalFeedback).toBe(3);
      // (5 + 4 + 1) / 3 = 10 / 3 = 3.333...
      expect(analytics.averageRating).toBeCloseTo(3.333, 2);

      expect(analytics.ratingDistribution).toEqual(expect.arrayContaining([
        expect.objectContaining({ star: 5, count: 1 }),
        expect.objectContaining({ star: 4, count: 1 }),
        expect.objectContaining({ star: 3, count: 0 }),
        expect.objectContaining({ star: 2, count: 0 }),
        expect.objectContaining({ star: 1, count: 1 }),
      ]));

      expect(analytics.sentimentBreakdown).toEqual({
        positive: 2,
        neutral: 0,
        negative: 1,
      });

      expect(analytics.agentScores).toHaveLength(2);
      const agentA = analytics.agentScores.find(a => a.agent === 'A');
      expect(agentA?.averageRating).toBe(4.5);
    });
  });
});
