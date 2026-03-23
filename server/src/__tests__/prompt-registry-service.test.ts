import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PromptRegistryService } from '../services/prompt-registry-service.js';

describe('PromptRegistryService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: PromptRegistryService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-prompt-'));
    process.chdir(tempDir);
    service = new PromptRegistryService();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('CRUD Operations', () => {
    it('creates and retrieves a template', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        description: 'A test template',
        category: 'task',
        content: 'Hello {{name}}!',
      });

      expect(template.id).toBeDefined();
      expect(template.name).toBe('test-template');
      expect(template.description).toBe('A test template');
      expect(template.category).toBe('task');
      expect(template.content).toBe('Hello {{name}}!');
      expect(template.variables).toEqual(['name']);
      expect(template.currentVersionId).toBe(`${template.id}_v1`);

      const retrieved = await service.getTemplate(template.id);
      expect(retrieved).toMatchObject(template);
    });

    it('returns null when getting non-existent template', async () => {
      expect(await service.getTemplate('non-existent')).toBeNull();
    });

    it('lists templates', async () => {
      await service.createTemplate({ name: 'template1', content: 'test1' });
      await service.createTemplate({ name: 'template2', content: 'test2' });

      const templates = await service.getTemplates();
      expect(templates.length).toBe(2);
      expect(templates.map((t) => t.name).sort()).toEqual(['template1', 'template2']);
    });

    it('updates a template without changing content', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        content: 'test content',
      });

      const updated = await service.updateTemplate(template.id, {
        name: 'updated-name',
      });

      expect(updated?.name).toBe('updated-name');
      expect(updated?.content).toBe('test content');
      expect(updated?.currentVersionId).toBe(template.currentVersionId);
    });

    it('updates a template content and creates a new version', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        content: 'Hello {{name}}!',
      });

      const updated = await service.updateTemplate(template.id, {
        content: 'Hello {{name}}! Welcome to {{place}}.',
        changelog: 'Added place variable',
      });

      expect(updated?.content).toBe('Hello {{name}}! Welcome to {{place}}.');
      expect(updated?.variables).toEqual(['name', 'place']);
      expect(updated?.currentVersionId).toBe(`${template.id}_v2`);

      const versions = await service.getVersionHistory(template.id);
      expect(versions.length).toBe(2);
      expect(versions[0].versionNumber).toBe(2);
      expect(versions[0].changelog).toBe('Added place variable');
      expect(versions[1].versionNumber).toBe(1);
    });

    it('throws when updating content without changelog', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        content: 'test content',
      });

      await expect(
        service.updateTemplate(template.id, { content: 'new content' })
      ).rejects.toThrow('changelog is required when updating template content');
    });

    it('returns null when updating non-existent template', async () => {
      expect(await service.updateTemplate('non-existent', { name: 'test' })).toBeNull();
    });

    it('deletes a template and its history/usage', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        content: 'test content',
      });

      await service.recordUsage(template.id, 'user1');

      const deleted = await service.deleteTemplate(template.id);
      expect(deleted).toBe(true);

      expect(await service.getTemplate(template.id)).toBeNull();
      expect(await service.getVersionHistory(template.id)).toEqual([]);
      expect(await service.getUsageRecords(template.id)).toEqual([]);
    });

    it('returns false when deleting non-existent template', async () => {
      expect(await service.deleteTemplate('non-existent')).toBe(false);
    });
  });

  describe('Variable Rendering', () => {
    it('renders a template with variables', () => {
      const result = service.renderTemplate('Hello {{name}}, welcome to {{place}}!', {
        name: 'Alice',
        place: 'Wonderland',
      });

      expect(result.renderedPrompt).toBe('Hello Alice, welcome to Wonderland!');
      expect(result.unmatchedVariables).toEqual([]);
    });

    it('identifies unmatched variables', () => {
      const result = service.renderTemplate('Hello {{name}}, welcome to {{place}}!', {
        name: 'Alice',
      });

      expect(result.renderedPrompt).toBe('Hello Alice, welcome to {{place}}!');
      expect(result.unmatchedVariables).toEqual(['place']);
    });

    it('handles multiple occurrences of the same variable', () => {
      const result = service.renderTemplate('{{name}} is {{name}}', {
        name: 'Bob',
      });

      expect(result.renderedPrompt).toBe('Bob is Bob');
      expect(result.unmatchedVariables).toEqual([]);
    });

    it('renders preview correctly via async method', async () => {
      const template = await service.createTemplate({
        name: 'preview-template',
        content: 'Hi {{name}}!',
      });

      const result = await service.renderPreview({
        templateId: template.id,
        sampleVariables: { name: 'Charlie' },
      });

      expect(result.renderedPrompt).toBe('Hi Charlie!');
    });

    it('throws when rendering preview for non-existent template', async () => {
      await expect(
        service.renderPreview({
          templateId: 'non-existent',
          sampleVariables: {},
        })
      ).rejects.toThrow(/not found/);
    });
  });

  describe('Usage and Stats', () => {
    it('records and retrieves usage', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        content: 'test',
      });

      await service.recordUsage(template.id, 'user1', 'test rendered', 'gpt-4', 10, 20);
      await service.recordUsage(template.id, 'user2', 'test rendered', 'gpt-4', 15, 25);

      const usage = await service.getUsageRecords(template.id);
      expect(usage.length).toBe(2);
      expect(usage[0].usedBy).toBe('user1');
      expect(usage[1].usedBy).toBe('user2');
    });

    it('calculates stats correctly', async () => {
      const template = await service.createTemplate({
        name: 'stats-template',
        content: 'test',
      });

      await service.recordUsage(template.id, 'user1', 'test', 'gpt-4', 10, 20); // 30 tokens
      await service.recordUsage(template.id, 'user1', 'test', 'gpt-4', 20, 30); // 50 tokens
      await service.recordUsage(template.id, 'user2', 'test', 'gpt-4', 10, 10); // 20 tokens

      const stats = await service.getStats(template.id);
      expect(stats).toBeDefined();
      expect(stats?.totalUsages).toBe(3);
      expect(stats?.totalVersions).toBe(1);
      expect(stats?.mostFrequentUser).toBe('user1');
      expect(stats?.averageTokensPerUsage).toBe((30 + 50 + 20) / 3);
    });

    it('returns null stats for non-existent template', async () => {
      expect(await service.getStats('non-existent')).toBeNull();
    });

    it('gets all stats sorted by total usages', async () => {
      const t1 = await service.createTemplate({ name: 't1', content: 'test' });
      const t2 = await service.createTemplate({ name: 't2', content: 'test' });

      await service.recordUsage(t1.id);
      await service.recordUsage(t1.id);
      await service.recordUsage(t2.id);

      const allStats = await service.getAllStats();
      expect(allStats.length).toBe(2);
      expect(allStats[0].templateId).toBe(t1.id); // 2 usages
      expect(allStats[1].templateId).toBe(t2.id); // 1 usage
    });
  });
});
