import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate, authorizeWrite } from '../middleware/auth.js';
import { ValidationError } from '../middleware/error-handler.js';
import { getStaleTaskWatchdogService } from '../services/stale-task-watchdog-service.js';

const router: RouterType = Router();
router.use(authenticate);
router.use(authorizeWrite);

const staleQuerySchema = z.object({
  taskThresholdMinutes: z.coerce.number().int().positive().optional(),
  heartbeatThresholdMinutes: z.coerce.number().int().positive().optional(),
});

const staleRunSchema = staleQuerySchema.extend({
  postComments: z.boolean().optional().default(true),
  commentThrottleMinutes: z.number().int().positive().optional(),
  maxCommentsPerRun: z.number().int().positive().optional(),
});

function parseQuery(query: unknown): z.infer<typeof staleQuerySchema> {
  const parsed = staleQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError('Invalid stale-task query', parsed.error.issues);
  }
  return parsed.data;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseQuery(req.query);
    const report = await getStaleTaskWatchdogService().report(query);
    res.json(report);
  })
);

router.post(
  '/run',
  asyncHandler(async (req, res) => {
    const parsed = staleRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid stale-task run options', parsed.error.issues);
    }

    const result = await getStaleTaskWatchdogService().run(parsed.data);
    res.json(result);
  })
);

export { router as staleTaskRoutes };
