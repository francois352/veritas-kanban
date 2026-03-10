import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { PromptTemplateService } from '../services/prompt-template-service.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError } from '../middleware/error-handler.js';

const router: RouterType = Router();
const promptTemplateService = new PromptTemplateService();

const createPromptTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  changelog: z.string().optional(),
});

const updatePromptTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  changelog: z.string().optional(),
});

const renderPromptTemplateSchema = z.object({
  variables: z.record(z.string()),
});

// GET /api/v1/prompt-templates - List all prompt templates
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tag = req.query.tag as string | undefined;
    const templates = await promptTemplateService.listTemplates(tag);
    res.json(templates);
  })
);

// POST /api/v1/prompt-templates - Create prompt template
router.post(
  '/',
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
    const template = await promptTemplateService.createTemplate(input);
    res.status(201).json(template);
  })
);

// GET /api/v1/prompt-templates/:id - Get single prompt template with all versions
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await promptTemplateService.getTemplate(req.params.id as string);
    if (!template) {
      throw new NotFoundError('Prompt template not found');
    }
    res.json(template);
  })
);

// PATCH /api/v1/prompt-templates/:id - Update prompt template (creates new version if content changed)
router.patch(
  '/:id',
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
    const template = await promptTemplateService.updateTemplate(req.params.id as string, input);
    if (!template) {
      throw new NotFoundError('Prompt template not found');
    }
    res.json(template);
  })
);

// POST /api/v1/prompt-templates/:id/render - Render prompt template with variables
router.post(
  '/:id/render',
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = renderPromptTemplateSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Validation failed', error.issues);
      }
      throw error;
    }
    const rendered = await promptTemplateService.renderTemplateById(req.params.id as string, input.variables);
    if (rendered === null) {
      throw new NotFoundError('Prompt template not found');
    }
    res.json({ rendered });
  })
);

// GET /api/v1/prompt-templates/:id/versions/:version - Get specific version
router.get(
  '/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const template = await promptTemplateService.getTemplate(req.params.id as string);
    if (!template) {
      throw new NotFoundError('Prompt template not found');
    }
    const versionNumber = parseInt(req.params.version as string, 10);
    const version = template.versions.find((v) => v.version === versionNumber);
    if (!version) {
      throw new NotFoundError('Version not found');
    }
    res.json(version);
  })
);

// DELETE /api/v1/prompt-templates/:id - Delete prompt template
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await promptTemplateService.deleteTemplate(req.params.id as string);
    if (!deleted) {
      throw new NotFoundError('Prompt template not found');
    }
    res.status(204).send();
  })
);

export default router;
