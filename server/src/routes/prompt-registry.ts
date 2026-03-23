import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { PromptRegistryService } from '../services/prompt-registry-service.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError } from '../middleware/error-handler.js';
import { writeRateLimit } from '../middleware/rate-limit.js'; // Rate limiting

const router: RouterType = Router();
const promptService = new PromptRegistryService();

// Validation schemas
// Input length limits
const createPromptTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(100),
  description: z.string().max(500).optional(),
  category: z.enum(['system', 'agent', 'tool', 'evaluation']),
  content: z.string().min(1, 'Template content is required').max(50000),
});

// Input length limits
const updatePromptTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  category: z.enum(['system', 'agent', 'tool', 'evaluation']).optional(),
  content: z.string().min(1).max(50000).optional(),
  changelog: z.string().max(1000).optional(),
});

// Input length limits
const renderPreviewSchema = z.object({
  templateId: z.string().max(100),
  sampleVariables: z.record(z.string().max(100), z.string().max(10000)),
});

// Input length limits
const recordUsageSchema = z.object({
  usedBy: z.string().max(100).optional(),
  renderedPrompt: z.string().max(50000).optional(),
  model: z.string().max(100).optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

// GET /api/prompt-registry - List all templates
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const templates = await promptService.getTemplates();
    res.json(templates);
  })
);

// GET /api/prompt-registry/:id - Get single template
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await promptService.getTemplate(req.params.id as string);
    if (!template) {
      throw new NotFoundError('Template not found');
    }
    res.json(template);
  })
);

// POST /api/prompt-registry - Create template
router.post(
  '/',
  writeRateLimit, // Rate limiting
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = createPromptTemplateSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Validation failed', error.issues);
      }
      throw error;
    }
    const template = await promptService.createTemplate(input);
    res.status(201).json(template);
  })
);

// PATCH /api/prompt-registry/:id - Update template
router.patch(
  '/:id',
  writeRateLimit, // Rate limiting
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = updatePromptTemplateSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Validation failed', error.issues);
      }
      throw error;
    }
    const template = await promptService.updateTemplate(req.params.id as string, input);
    if (!template) {
      throw new NotFoundError('Template not found');
    }
    res.json(template);
  })
);

// DELETE /api/prompt-registry/:id - Delete template
router.delete(
  '/:id',
  writeRateLimit, // Rate limiting
  asyncHandler(async (req, res) => {
    const deleted = await promptService.deleteTemplate(req.params.id as string);
    if (!deleted) {
      throw new NotFoundError('Template not found');
    }
    res.status(204).send();
  })
);

// GET /api/prompt-registry/:id/versions - Get version history
router.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const versions = await promptService.getVersionHistory(req.params.id as string);
    res.json(versions);
  })
);

// GET /api/prompt-registry/:id/usage - Get usage records
router.get(
  '/:id/usage',
  asyncHandler(async (req, res) => {
    const usageRecords = await promptService.getUsageRecords(req.params.id as string);
    res.json(usageRecords);
  })
);

// GET /api/prompt-registry/:id/stats - Get template statistics
router.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const stats = await promptService.getStats(req.params.id as string);
    if (!stats) {
      throw new NotFoundError('Template not found');
    }
    res.json(stats);
  })
);

// GET /api/prompt-registry/stats/all - Get all template statistics
router.get(
  '/stats/all',
  asyncHandler(async (_req, res) => {
    const allStats = await promptService.getAllStats();
    res.json(allStats);
  })
);

// POST /api/prompt-registry/:id/render-preview - Render template with sample variables
router.post(
  '/:id/render-preview',
  writeRateLimit, // Rate limiting
  asyncHandler(async (req, res) => {
    let request;
    try {
      request = renderPreviewSchema.parse({
        templateId: req.params.id,
        sampleVariables: req.body.sampleVariables,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Validation failed', error.issues);
      }
      throw error;
    }
    const preview = await promptService.renderPreview(request);
    res.json(preview);
  })
);

// POST /api/prompt-registry/:id/record-usage - Track template usage
router.post(
  '/:id/record-usage',
  writeRateLimit, // Rate limiting
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = recordUsageSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Validation failed', error.issues);
      }
      throw error;
    }

    const usage = await promptService.recordUsage(
      req.params.id as string,
      input.usedBy,
      input.renderedPrompt,
      input.model,
      input.inputTokens,
      input.outputTokens
    );
    res.status(201).json(usage);
  })
);

export default router;
