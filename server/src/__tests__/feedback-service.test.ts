import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { FeedbackService, detectSentiment } from '../services/feedback-service.js';

describe('detectSentiment', () => {
  it('detects positive, negative, and neutral text', () => {
    expect(detectSentiment('Great work, accurate and helpful')).toBe('positive');
    expect(detectSentiment('Broken, confusing, and not working')).toBe('negative');
    expect(detectSentiment('')).toBe('neutral');
    expect(detectSentiment('This exists.')).toBe('neutral');
  });
});

describe('FeedbackService', () => {
  let tmpDir: string;
  let service: FeedbackService;
  let cwdSpy: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-service-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    service = new FeedbackService();
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates, gets, updates, and deletes feedback', async () => {
    const created = await service.create({
      taskId: 'task-1',
      agent: 'VERITAS',
      rating: 5,
      comment: 'Great fix, very helpful',
      categories: ['quality', 'accuracy'],
    });

    expect(created.sentiment).toBe('positive');
    expect(await service.get(created.id)).toMatchObject({ id: created.id, resolved: false });

    const updated = await service.update(created.id, {
      comment: 'Broken now and not working',
      resolved: true,
      rating: 2,
    });

    expect(updated).toMatchObject({ resolved: true, rating: 2, sentiment: 'negative' });
    expect(await service.delete(created.id)).toBe(true);
    expect(await service.get(created.id)).toBeNull();
    expect(await service.delete(created.id)).toBe(false);
  });

  it('lists feedback with filters, sorting, and limit', async () => {
    const first = await service.create({
      taskId: 'task-a',
      agent: 'A',
      rating: 4,
      comment: 'good and clear',
      categories: ['ux'],
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await service.create({
      taskId: 'task-b',
      agent: 'B',
      rating: 1,
      comment: 'bad bug and failure',
      categories: ['safety'],
    });
    await service.update(second.id, { resolved: true });

    expect((await service.list()).map((f) => f.id)).toEqual([second.id, first.id]);
    expect((await service.list({ taskId: 'task-a' })).map((f) => f.id)).toEqual([first.id]);
    expect(
      (await service.list({ agent: 'B', sentiment: 'negative', resolved: true })).map((f) => f.id)
    ).toEqual([second.id]);
    expect((await service.list({ category: 'ux', limit: 1 })).length).toBe(1);
  });

  it('builds analytics and unresolved list', async () => {
    const now = new Date('2026-03-01T10:00:00.000Z').toISOString();
    const later = new Date('2026-03-02T11:00:00.000Z').toISOString();

    const a = await service.create({
      taskId: 'task-1',
      agent: 'A',
      rating: 5,
      comment: 'excellent and fast',
      categories: ['quality', 'performance'],
    });
    const b = await service.create({
      taskId: 'task-2',
      agent: 'B',
      rating: 2,
      comment: 'wrong and confusing',
      categories: ['accuracy', 'ux'],
    });

    const feedbackDir = path.join(tmpDir, 'storage', 'feedback');
    await fs.writeFile(
      path.join(feedbackDir, `${a.id}.json`),
      JSON.stringify({ ...a, createdAt: now, updatedAt: now }, null, 2),
      'utf8'
    );
    await fs.writeFile(
      path.join(feedbackDir, `${b.id}.json`),
      JSON.stringify({ ...b, createdAt: later, updatedAt: later, resolved: true }, null, 2),
      'utf8'
    );

    const analytics = await service.getAnalytics();
    expect(analytics.totalFeedback).toBe(2);
    expect(analytics.averageRating).toBe(3.5);
    expect(analytics.ratingDistribution.find((r) => r.star === 5)?.count).toBe(1);
    expect(analytics.sentimentBreakdown).toEqual({ positive: 1, neutral: 0, negative: 1 });
    expect(analytics.categoryBreakdown).toMatchObject({
      quality: 1,
      performance: 1,
      accuracy: 1,
      ux: 1,
      safety: 0,
    });
    expect(analytics.unresolvedCount).toBe(1);
    expect(analytics.satisfactionTrends.map((t) => t.date)).toEqual(['2026-03-01', '2026-03-02']);
    expect(analytics.agentScores.map((s) => s.agent)).toEqual(['B', 'A']);

    const unresolved = await service.listUnresolved();
    expect(unresolved.map((f) => f.id)).toEqual([a.id]);
  });

  it('ignores corrupt feedback files and returns null when update target is missing', async () => {
    const dir = path.join(tmpDir, 'storage', 'feedback');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'broken.json'), '{bad json', 'utf8');

    await expect(service.list()).resolves.toEqual([]);
    await expect(service.get('missing')).resolves.toBeNull();
    await expect(service.update('missing', { resolved: true })).resolves.toBeNull();
  });
});
