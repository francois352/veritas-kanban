import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/error-handler.js';

const mockPromptRegistryServiceInstance = vi.hoisted(() => ({
  getTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  getVersionHistory: vi.fn(),
  getUsageRecords: vi.fn(),
  getStats: vi.fn(),
  getAllStats: vi.fn(),
  renderPreview: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('../../services/prompt-registry-service.js', () => {
  return {
    PromptRegistryService: class {
      getTemplates = mockPromptRegistryServiceInstance.getTemplates;
      getTemplate = mockPromptRegistryServiceInstance.getTemplate;
      createTemplate = mockPromptRegistryServiceInstance.createTemplate;
      updateTemplate = mockPromptRegistryServiceInstance.updateTemplate;
      deleteTemplate = mockPromptRegistryServiceInstance.deleteTemplate;
      getVersionHistory = mockPromptRegistryServiceInstance.getVersionHistory;
      getUsageRecords = mockPromptRegistryServiceInstance.getUsageRecords;
      getStats = mockPromptRegistryServiceInstance.getStats;
      getAllStats = mockPromptRegistryServiceInstance.getAllStats;
      renderPreview = mockPromptRegistryServiceInstance.renderPreview;
      recordUsage = mockPromptRegistryServiceInstance.recordUsage;
    },
  };
});

import promptRegistryRoutes from '../../routes/prompt-registry.js';

describe('Prompt Registry Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/prompt-registry', promptRegistryRoutes);
    app.use(errorHandler);
  });

  describe('GET /api/prompt-registry', () => {
    it('returns a list of templates', async () => {
      mockPromptRegistryServiceInstance.getTemplates.mockResolvedValue([{ id: 'tpl_1' }]);

      const response = await request(app).get('/api/prompt-registry');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockPromptRegistryServiceInstance.getTemplates).toHaveBeenCalled();
    });
  });

  describe('GET /api/prompt-registry/:id', () => {
    it('returns a specific template', async () => {
      mockPromptRegistryServiceInstance.getTemplate.mockResolvedValue({ id: 'tpl_1' });

      const response = await request(app).get('/api/prompt-registry/tpl_1');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('tpl_1');
      expect(mockPromptRegistryServiceInstance.getTemplate).toHaveBeenCalledWith('tpl_1');
    });

    it('returns 404 if template not found', async () => {
      mockPromptRegistryServiceInstance.getTemplate.mockResolvedValue(null);

      const response = await request(app).get('/api/prompt-registry/tpl_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/prompt-registry', () => {
    it('creates a new template', async () => {
      mockPromptRegistryServiceInstance.createTemplate.mockResolvedValue({ id: 'tpl_1' });

      const response = await request(app).post('/api/prompt-registry').send({
        name: 'test-template',
        category: 'system',
        content: 'test content',
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('tpl_1');
      expect(mockPromptRegistryServiceInstance.createTemplate).toHaveBeenCalledWith({
        name: 'test-template',
        category: 'system',
        content: 'test content',
      });
    });

    it('returns 400 for invalid input', async () => {
      const response = await request(app).post('/api/prompt-registry').send({
        name: 'test-template',
        // missing category and content
      });

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /api/prompt-registry/:id', () => {
    it('updates a template', async () => {
      mockPromptRegistryServiceInstance.updateTemplate.mockResolvedValue({ id: 'tpl_1' });

      const response = await request(app).patch('/api/prompt-registry/tpl_1').send({
        name: 'updated-template',
      });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('tpl_1');
      expect(mockPromptRegistryServiceInstance.updateTemplate).toHaveBeenCalledWith('tpl_1', {
        name: 'updated-template',
      });
    });

    it('returns 404 if template to update is not found', async () => {
      mockPromptRegistryServiceInstance.updateTemplate.mockResolvedValue(null);

      const response = await request(app).patch('/api/prompt-registry/tpl_not_found').send({
        name: 'updated',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/prompt-registry/:id', () => {
    it('deletes a template', async () => {
      mockPromptRegistryServiceInstance.deleteTemplate.mockResolvedValue(true);

      const response = await request(app).delete('/api/prompt-registry/tpl_1');

      expect(response.status).toBe(204);
      expect(mockPromptRegistryServiceInstance.deleteTemplate).toHaveBeenCalledWith('tpl_1');
    });

    it('returns 404 if template to delete is not found', async () => {
      mockPromptRegistryServiceInstance.deleteTemplate.mockResolvedValue(false);

      const response = await request(app).delete('/api/prompt-registry/tpl_not_found');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/prompt-registry/:id/versions', () => {
    it('returns version history', async () => {
      mockPromptRegistryServiceInstance.getVersionHistory.mockResolvedValue([{ version: 1 }]);

      const response = await request(app).get('/api/prompt-registry/tpl_1/versions');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockPromptRegistryServiceInstance.getVersionHistory).toHaveBeenCalledWith('tpl_1');
    });
  });

  describe('GET /api/prompt-registry/:id/usage', () => {
    it('returns usage records', async () => {
      mockPromptRegistryServiceInstance.getUsageRecords.mockResolvedValue([{ id: 'usage_1' }]);

      const response = await request(app).get('/api/prompt-registry/tpl_1/usage');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockPromptRegistryServiceInstance.getUsageRecords).toHaveBeenCalledWith('tpl_1');
    });
  });

  describe('GET /api/prompt-registry/:id/stats', () => {
    it('returns stats for a template', async () => {
      mockPromptRegistryServiceInstance.getStats.mockResolvedValue({ totalUsage: 5 });

      const response = await request(app).get('/api/prompt-registry/tpl_1/stats');

      expect(response.status).toBe(200);
      expect(response.body.totalUsage).toBe(5);
      expect(mockPromptRegistryServiceInstance.getStats).toHaveBeenCalledWith('tpl_1');
    });

    it('returns 404 if template stats not found', async () => {
      mockPromptRegistryServiceInstance.getStats.mockResolvedValue(null);

      const response = await request(app).get('/api/prompt-registry/tpl_not_found/stats');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/prompt-registry/stats/all', () => {
    it('returns all template statistics', async () => {
      mockPromptRegistryServiceInstance.getAllStats.mockResolvedValue([{ totalUsage: 5 }]);

      const response = await request(app).get('/api/prompt-registry/stats/all');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(mockPromptRegistryServiceInstance.getAllStats).toHaveBeenCalled();
    });
  });

  describe('POST /api/prompt-registry/:id/render-preview', () => {
    it('renders a preview', async () => {
      mockPromptRegistryServiceInstance.renderPreview.mockResolvedValue({ rendered: 'hello world' });

      const response = await request(app).post('/api/prompt-registry/tpl_1/render-preview').send({
        sampleVariables: { name: 'world' },
      });

      expect(response.status).toBe(200);
      expect(response.body.rendered).toBe('hello world');
      expect(mockPromptRegistryServiceInstance.renderPreview).toHaveBeenCalledWith({
        templateId: 'tpl_1',
        sampleVariables: { name: 'world' },
      });
    });

    it('returns 400 for invalid payload', async () => {
      const response = await request(app).post('/api/prompt-registry/tpl_1/render-preview').send({
        // missing sampleVariables
      });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/prompt-registry/:id/record-usage', () => {
    it('records usage', async () => {
      mockPromptRegistryServiceInstance.recordUsage.mockResolvedValue({ id: 'usage_1' });

      const response = await request(app).post('/api/prompt-registry/tpl_1/record-usage').send({
        usedBy: 'user_1',
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('usage_1');
      expect(mockPromptRegistryServiceInstance.recordUsage).toHaveBeenCalledWith(
        'tpl_1',
        'user_1',
        undefined,
        undefined,
        undefined,
        undefined
      );
    });
  });
});
