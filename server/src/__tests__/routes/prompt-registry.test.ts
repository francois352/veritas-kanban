import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import promptRegistryRoutes from '../../routes/prompt-registry.js';
import { errorHandler } from '../../middleware/error-handler.js';

const mockPromptService = vi.hoisted(() => ({
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  renderPreview: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('../../services/prompt-registry-service.js', () => ({
  PromptRegistryService: class {
    createTemplate = mockPromptService.createTemplate;
    updateTemplate = mockPromptService.updateTemplate;
    deleteTemplate = mockPromptService.deleteTemplate;
    renderPreview = mockPromptService.renderPreview;
    recordUsage = mockPromptService.recordUsage;
  },
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/prompt-registry', promptRegistryRoutes);
app.use(errorHandler);

describe('Prompt Registry Routes - Security & Governance Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should enforce writeRateLimit on POST /api/prompt-registry', async () => {
      mockPromptService.createTemplate.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .post('/api/prompt-registry')
          .set('X-Forwarded-For', '192.168.1.112')
          .send({
            name: 'Template',
            category: 'system',
            content: 'Hello'
          });
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error).toContain('Too many write requests');
    });

    it('should enforce writeRateLimit on PATCH /api/prompt-registry/:id', async () => {
      mockPromptService.updateTemplate.mockResolvedValue({});

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .patch('/api/prompt-registry/123')
          .set('X-Forwarded-For', '192.168.1.113')
          .send({ name: 'New Name' });
      }

      expect(res?.status).toBe(429);
    });

    it('should enforce writeRateLimit on DELETE /api/prompt-registry/:id', async () => {
      mockPromptService.deleteTemplate.mockResolvedValue(true);

      let res;
      for (let i = 0; i < 65; i++) {
        res = await request(app)
          .delete('/api/prompt-registry/123')
          .set('X-Forwarded-For', '192.168.1.114');
      }

      expect(res?.status).toBe(429);
    });
  });

  describe('Input Length Limits', () => {
    it('should reject overly long template name in POST', async () => {
      const longName = 'A'.repeat(101);
      const res = await request(app)
        .post('/api/prompt-registry')
        .send({
          name: longName,
          category: 'system',
          content: 'Hello'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject overly long renderedPrompt in record-usage', async () => {
      const longPrompt = 'A'.repeat(50001);
      const res = await request(app)
        .post('/api/prompt-registry/123/record-usage')
        .send({
          renderedPrompt: longPrompt
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
