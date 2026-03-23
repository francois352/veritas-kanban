import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('PromptRegistryService', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let service: any; // Type it correctly when imported

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vk-prompt-'));
    process.chdir(tempDir);

    // Process.cwd() is used when constructing PromptRegistryService
    vi.resetModules();
    const { PromptRegistryService } = await import('../services/prompt-registry-service.js');
    service = new PromptRegistryService();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('CRUD Operations', () => {
    it('creates and retrieves a template', async () => {
      const template = await service.createTemplate({
        name: 'test-template',
        description: 'A test prompt template',
        category: 'test',
        content: 'Hello {{name}}, you are {{age}} years old.',
      });

      expect(template.id).toBeDefined();
      expect(template.name).toBe('test-template');
      expect(template.content).toBe('Hello {{name}}, you are {{age}} years old.');
      expect(template.variables).toEqual(['age', 'name']);
      expect(template.currentVersionId).toBe(`${template.id}_v1`);

      const retrieved = await service.getTemplate(template.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(template.id);
      expect(retrieved?.name).toBe('test-template');
    });

    it('lists templates', async () => {
      await service.createTemplate({
        name: 'template-1',
        description: 'First template',
        category: 'general',
        content: 'Content 1',
      });

      await service.createTemplate({
        name: 'template-2',
        description: 'Second template',
        category: 'general',
        content: 'Content 2',
      });

      const templates = await service.getTemplates();
      expect(templates).toHaveLength(2);
      // Ensure sorted by name ascending
      expect(templates[0]?.name).toBe('template-1');
      expect(templates[1]?.name).toBe('template-2');
    });
  });

  describe('Template Rendering', () => {
    it('renders a template and returns matched/unmatched variables', () => {
      const content = 'Hello {{name}}, welcome to {{location}}!';
      const variables = { name: 'Alice', unused: 'value' };

      const result = service.renderTemplate(content, variables);

      expect(result.renderedPrompt).toBe('Hello Alice, welcome to {{location}}!');
      expect(result.unmatchedVariables).toEqual(['location']);
    });
  });
});
