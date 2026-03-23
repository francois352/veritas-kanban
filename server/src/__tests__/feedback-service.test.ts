import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { feedbackService, detectSentiment } from '../services/feedback-service.js';

describe('FeedbackService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-feedback-'));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // Force clean the directory between tests since feedbackService is a singleton
  beforeEach(async () => {
    const dir = join(tempDir, 'storage', 'feedback');
    await rm(dir, { recursive: true, force: true }).catch(() => {});

    // Also clean up original process.cwd() storage/feedback since feedbackService uses process.cwd() inside it instead of relative to execution dir if process.cwd() is used when instantiating the singleton. Oh wait, it gets evaluated when the file is required.
    const originalDir = join(originalCwd, 'storage', 'feedback');
    await rm(originalDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('Sentiment Detection', () => {
    it('detects positive sentiment', () => {
      expect(detectSentiment('This is an excellent and amazing piece of code.')).toBe('positive');
      expect(detectSentiment('thanks for fixing the issue, it works perfectly now')).toBe('positive');
    });

    it('detects negative sentiment', () => {
      expect(detectSentiment('This is a terrible bug and it crashes the app.')).toBe('negative');
      expect(detectSentiment('slow and horrible performance')).toBe('negative');
    });

    it('detects neutral sentiment', () => {
      expect(detectSentiment('I have reviewed the PR.')).toBe('neutral');
      expect(detectSentiment('')).toBe('neutral');
      expect(detectSentiment('   ')).toBe('neutral');
    });

    it('weighs positive and negative keywords', () => {
      // 2 positive (good, fixed) vs 1 negative (bug)
      expect(detectSentiment('It is good that you fixed the bug.')).toBe('positive');

      // 'thanks'/'thank' both match (2 positive) vs 'broken'/'awful'/'fail'/'failure'
      expect(detectSentiment('Thanks, but it is broken and awful and a failure.')).toBe('negative');
    });
  });

  describe('CRUD Operations', () => {
    it('creates and retrieves feedback', async () => {
      const feedback = await feedbackService.create({
        taskId: 'TASK-1',
        agent: 'coder',
        rating: 5,
        comment: 'Great job!',
        categories: ['quality', 'performance'],
      });

      expect(feedback.id).toBeDefined();
      expect(feedback.taskId).toBe('TASK-1');
      expect(feedback.agent).toBe('coder');
      expect(feedback.rating).toBe(5);
      expect(feedback.comment).toBe('Great job!');
      expect(feedback.categories).toEqual(['quality', 'performance']);
      expect(feedback.sentiment).toBe('positive');
      expect(feedback.resolved).toBe(false);

      const retrieved = await feedbackService.get(feedback.id);
      expect(retrieved).toMatchObject(feedback);
    });

    it('returns null when getting non-existent feedback', async () => {
      expect(await feedbackService.get('non-existent')).toBeNull();
    });

    it('lists feedback with pagination and filters', async () => {
      await feedbackService.create({ taskId: 'T-1', agent: 'coder', rating: 4 });
      await feedbackService.create({ taskId: 'T-2', agent: 'reviewer', rating: 2 });
      await feedbackService.create({ taskId: 'T-3', agent: 'coder', rating: 5, categories: ['safety'] });

      // All items
      const all = await feedbackService.list();
      expect(all.length).toBe(3);

      // Filter by agent
      const coderFeedback = await feedbackService.list({ agent: 'coder' });
      expect(coderFeedback.length).toBe(2);

      // Filter by taskId
      const t2Feedback = await feedbackService.list({ taskId: 'T-2' });
      expect(t2Feedback.length).toBe(1);

      // Filter by category
      const safetyFeedback = await feedbackService.list({ category: 'safety' });
      expect(safetyFeedback.length).toBe(1);

      // Limit
      const limited = await feedbackService.list({ limit: 2 });
      expect(limited.length).toBe(2);
    });

    it('updates feedback', async () => {
      const feedback = await feedbackService.create({
        taskId: 'TASK-1',
        agent: 'coder',
        rating: 3,
        comment: 'Okay work.',
      });

      const updated = await feedbackService.update(feedback.id, {
        rating: 5,
        comment: 'Actually, it is amazing!',
        resolved: true,
      });

      expect(updated?.rating).toBe(5);
      expect(updated?.comment).toBe('Actually, it is amazing!');
      expect(updated?.sentiment).toBe('positive'); // Sentiment should recalculate
      expect(updated?.resolved).toBe(true);

      const retrieved = await feedbackService.get(feedback.id);
      expect(retrieved?.rating).toBe(5);
      expect(retrieved?.resolved).toBe(true);
    });

    it('returns null when updating non-existent feedback', async () => {
      expect(await feedbackService.update('non-existent', { rating: 5 })).toBeNull();
    });

    it('deletes feedback', async () => {
      const feedback = await feedbackService.create({
        taskId: 'TASK-1',
        agent: 'coder',
        rating: 5,
      });

      const deleted = await feedbackService.delete(feedback.id);
      expect(deleted).toBe(true);
      expect(await feedbackService.get(feedback.id)).toBeNull();
    });

    it('returns false when deleting non-existent feedback', async () => {
      expect(await feedbackService.delete('non-existent')).toBe(false);
    });

    it('handles concurrent creates safely', async () => {
      const promises = Array.from({ length: 10 }).map((_, i) =>
        feedbackService.create({
          taskId: `TASK-${i}`,
          agent: 'coder',
          rating: 4,
        })
      );

      await Promise.all(promises);

      const all = await feedbackService.list();
      expect(all.length).toBe(10);
    });

    it('handles concurrent updates to the same feedback safely', async () => {
      const feedback = await feedbackService.create({
        taskId: 'TASK-1',
        agent: 'coder',
        rating: 1,
        categories: [],
      });

      const promises = Array.from({ length: 10 }).map((_, i) =>
        feedbackService.update(feedback.id, {
          rating: 5,
          comment: `Update ${i}`,
        })
      );

      await Promise.all(promises);

      const retrieved = await feedbackService.get(feedback.id);
      expect(retrieved?.rating).toBe(5);
      expect(retrieved?.comment).toMatch(/^Update \d$/);
    });
  });

  describe('Analytics', () => {
    it('generates analytics correctly', async () => {
      await feedbackService.create({ agent: 'coder', rating: 5, comment: 'excellent', categories: ['quality'] });
      await feedbackService.create({ agent: 'coder', rating: 4, comment: 'good', categories: ['performance'] });
      await feedbackService.create({ agent: 'reviewer', rating: 1, comment: 'terrible bug', categories: ['accuracy'] });
      await feedbackService.create({ agent: 'architect', rating: 3, comment: 'okay', categories: ['ux'] });

      const unresolvedFeedback = await feedbackService.listUnresolved();
      expect(unresolvedFeedback.length).toBe(4);

      // Resolve one piece of feedback
      await feedbackService.update(unresolvedFeedback[0].id, { resolved: true });

      const analytics = await feedbackService.getAnalytics();

      expect(analytics.totalFeedback).toBe(4);
      expect(analytics.averageRating).toBe((5 + 4 + 1 + 3) / 4);

      // Check rating distribution
      const r5 = analytics.ratingDistribution.find(r => r.star === 5);
      expect(r5?.count).toBe(1);
      const r1 = analytics.ratingDistribution.find(r => r.star === 1);
      expect(r1?.count).toBe(1);

      // Check agent scores
      const coderScore = analytics.agentScores.find(a => a.agent === 'coder');
      expect(coderScore?.averageRating).toBe(4.5);
      expect(coderScore?.totalFeedback).toBe(2);

      // Check sentiment breakdown
      expect(analytics.sentimentBreakdown.positive).toBe(2); // excellent, good
      expect(analytics.sentimentBreakdown.negative).toBe(1); // terrible bug
      expect(analytics.sentimentBreakdown.neutral).toBe(1); // okay

      // Check category breakdown
      expect(analytics.categoryBreakdown.quality).toBe(1);
      expect(analytics.categoryBreakdown.performance).toBe(1);
      expect(analytics.categoryBreakdown.accuracy).toBe(1);

      expect(analytics.unresolvedCount).toBe(3); // One was resolved
    });

    it('returns empty analytics when no feedback exists', async () => {
      const analytics = await feedbackService.getAnalytics();

      expect(analytics.totalFeedback).toBe(0);
      expect(analytics.averageRating).toBe(0);
      expect(analytics.agentScores).toEqual([]);
      expect(analytics.unresolvedCount).toBe(0);

      // Distributions should all be 0
      expect(analytics.ratingDistribution.every(r => r.count === 0)).toBe(true);
      expect(analytics.sentimentBreakdown.positive).toBe(0);
      expect(analytics.categoryBreakdown.quality).toBe(0);
    });

    it('lists unresolved feedback', async () => {
      await feedbackService.create({ rating: 5 });
      const f2 = await feedbackService.create({ rating: 4 });

      await feedbackService.update(f2.id, { resolved: true });

      const unresolved = await feedbackService.listUnresolved();
      expect(unresolved.length).toBe(1);
      expect(unresolved[0].id).not.toBe(f2.id);
    });
  });
});
