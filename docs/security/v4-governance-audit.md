# v4 Governance Endpoint Security Audit

Issue: #254
Scope: governance endpoints added in v4.0 (`chat`, `feedback`, `decisions`, `drift`, `templates`, `lifecycle-hooks`, related services/UI)
Method: read-only code audit against hardening patterns introduced in earlier security fixes (#231-#236)

## Summary

I found four real gaps in the v4.0 governance surface:

1. **High** — generic squad webhooks can issue arbitrary outbound requests without SSRF validation.
2. **Medium** — drift alert acknowledgement writes to disk using user-controlled IDs without `validatePathSegment()`.
3. **Medium** — several write-heavy governance endpoints lack explicit per-endpoint rate limiting.
4. **Low** — some governance schemas accept effectively unbounded strings/arrays, leaving room for oversized payload abuse and noisy persisted data.

I did **not** find a confirmed stored-XSS issue in the dashboard rendering path during this audit. The squad chat panel appears to render message content as plain React text rather than injecting HTML.

---

## FINDING-001 — Generic squad webhook path lacks SSRF validation

**Severity:** High
**Files:**

- `server/src/services/squad-webhook-service.ts:133-160`
- `server/src/services/squad-webhook-service.ts:166-192`
- `server/src/services/squad-webhook-service.ts:89-94` (shows the safe pattern used only for OpenClaw mode)

### Why this matters

The OpenClaw webhook path validates the destination URL with `validateWebhookUrl()`, but the generic webhook path does not. If an attacker can set `settings.url`, the server will `fetch()` arbitrary URLs, including internal services or link-local targets, creating an SSRF primitive.

### Vulnerable snippet

```ts
// server/src/services/squad-webhook-service.ts
async function fireGenericWebhook(
  message: SquadMessage,
  settings: SquadWebhookSettings,
  isHuman: boolean
): Promise<void> {
  if (!settings.url) {
    return;
  }

  // Fire asynchronously (don't block)
  fireWebhookAsync(settings.url, payload, settings.secret).catch((err) => {
    log.error({ err: err.message, messageId: message.id }, 'Squad webhook failed');
  });
}

async function fireWebhookAsync(
  url: string,
  payload: WebhookPayload,
  secret?: string
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal,
  });
}
```

### Safe pattern already present elsewhere

```ts
// server/src/services/squad-webhook-service.ts
const validation = validateWebhookUrl(url);
if (!validation.valid) {
  log.warn({ url, reason: validation.reason }, 'Webhook URL blocked (SSRF prevention)');
  return;
}
```

### Recommended fix

Apply `validateWebhookUrl()` to `settings.url` before calling `fireWebhookAsync()`, not just to the OpenClaw URL. Reject private, loopback, link-local, and non-HTTP(S) targets consistently.

---

## FINDING-002 — Drift alert acknowledgement writes files from unvalidated path segment

**Severity:** Medium
**Files:**

- `server/src/routes/drift.ts:29-45`
- `server/src/services/drift-service.ts:94-103`
- `server/src/schemas/drift-schemas.ts:22-24`

### Why this matters

The drift acknowledge route accepts `:id` as `nonEmptyString`, then uses it directly in a filesystem path: `${id}.json`. Unlike the safer template service pattern, this code does not call `validatePathSegment()` or `ensureWithinBase()`. A crafted ID containing path separators or traversal tokens could escape the alerts directory or target unexpected files, depending on platform/path normalization.

### Vulnerable snippet

```ts
// server/src/schemas/drift-schemas.ts
export const DriftAlertParamsSchema = z.object({
  id: nonEmptyString,
});

// server/src/services/drift-service.ts
async acknowledgeAlert(id: string): Promise<DriftAlert | null> {
  const filePath = path.join(this.alertsDir, `${id}.json`);
  if (!(await fileExists(filePath))) {
    return null;
  }

  const alert = JSON.parse(await readFile(filePath, 'utf-8')) as DriftAlert;
  const updated: DriftAlert = { ...alert, acknowledged: true };
  await this.writeJson(filePath, updated);
  return updated;
}
```

### Safer pattern used elsewhere

```ts
// server/src/services/template-service.ts
private templatePath(id: string): string {
  validatePathSegment(id);
  const filepath = join(this.templatesDir, `${id}.md`);
  ensureWithinBase(this.templatesDir, filepath);
  return filepath;
}
```

### Recommended fix

Constrain drift alert IDs with a strict schema or call `validatePathSegment()` plus `ensureWithinBase()` before reading/writing any alert file.

---

## FINDING-003 — Governance write endpoints missing explicit per-endpoint rate limits

**Severity:** Medium
**Files:**

- `server/src/routes/feedback.ts:105-134`
- `server/src/routes/decisions.ts:22-68`
- `server/src/routes/drift.ts:29-84`
- `server/src/routes/chat.ts:304-320` (read path shown; write endpoints reviewed in same file lacked explicit limiter attachment)
- `server/src/routes/templates.ts:83-131`
- `server/src/routes/lifecycle-hooks.ts:81-159`

### Why this matters

Earlier hardening work established a pattern of attaching targeted limiters (`writeRateLimit`, `strictRateLimit`, etc.) to sensitive routes. In the v4.0 governance routes reviewed here, write-heavy endpoints are exposed without explicit per-endpoint rate limiting. That leaves feedback creation, decision writes, drift recalculation/reset, template mutation, hook mutation, and chat posting more vulnerable to spam, abuse, and avoidable resource pressure.

### Vulnerable snippets

```ts
// server/src/routes/feedback.ts
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createFeedbackSchema, req.body);
    const item = await feedbackService.create(input);
    res.status(201).json(item);
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateFeedbackSchema, req.body);
    const item = await feedbackService.update(paramStr(req.params.id), input);
    res.json(item);
  })
);
```

```ts
// server/src/routes/decisions.ts
router.post(
  '/',
  validate({ body: createDecisionSchema }),
  asyncHandler(async (req, res) => {
    const decision = await decisionService.create(body);
    res.status(201).json(decision);
  })
);
```

```ts
// server/src/routes/drift.ts
router.post('/alerts/:id/acknowledge', validate({ params: DriftAlertParamsSchema }), ...);
router.post('/baselines/reset', validate({ body: DriftBaselineResetSchema }), ...);
router.post('/analyze', validate({ body: DriftAnalyzeSchema }), ...);
```

```ts
// server/src/routes/lifecycle-hooks.ts
router.post('/', asyncHandler(async (req, res) => { ... }));
router.patch('/:id', asyncHandler(async (req, res) => { ... }));
router.delete('/:id', asyncHandler(async (req, res) => { ... }));
router.post('/fire', asyncHandler(async (req, res) => { ... }));
```

### Recommended fix

Apply the same middleware pattern used in the prior hardening series:

- `writeRateLimit` on normal mutation endpoints.
- `strictRateLimit` on expensive or abuse-prone endpoints like chat posting, drift analysis/reset, and manual hook firing.
- Keep read endpoints on lighter read limits where appropriate.

---

## FINDING-004 — Several governance schemas allow oversized or weakly constrained payloads

**Severity:** Low
**Files:**

- `server/src/routes/templates.ts:11-60`
- `server/src/routes/lifecycle-hooks.ts:84-117, 144-154`
- `server/src/schemas/drift-schemas.ts:31-38`
- `server/src/schemas/common.ts:47`
- `server/src/schemas/decision-schemas.ts:22-31`

### Why this matters

The audited routes generally use Zod, which is good, but several fields still have no meaningful upper bounds or format constraints. That is not an immediate exploit by itself, but it increases the blast radius for oversized payloads, log noise, storage bloat, and unexpected downstream behavior.

### Examples

```ts
// server/src/schemas/common.ts
export const nonEmptyString = z.string().min(1, 'Value cannot be empty');
```

```ts
// server/src/schemas/decision-schemas.ts
export const createDecisionSchema = z.object({
  inputContext: nonEmptyString,
  outputAction: nonEmptyString,
  assumptions: z.array(AssumptionSchema).default([]),
  agentId: nonEmptyString,
  taskId: nonEmptyString,
});
```

```ts
// server/src/routes/templates.ts
const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  blueprint: z.array(blueprintTaskSchema).optional(),
});
```

```ts
// server/src/routes/lifecycle-hooks.ts
const schema = z.object({
  name: z.string().min(1),
  taskTypeFilter: z.array(z.string()).optional(),
  projectFilter: z.array(z.string()).optional(),
  priorityFilter: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
```

### Recommended fix

Add pragmatic limits and shape constraints for governance payloads, for example:

- max lengths for names, descriptions, task IDs, agent IDs, context strings, and freeform notes
- max item counts for arrays like assumptions, filters, blueprint tasks, and subtask templates
- stricter object schemas for `config` instead of open-ended `record<string, unknown>` when the action type is known
- `.trim()` on freeform strings where whitespace-only values should be rejected

---

## Notes on items reviewed but not confirmed as findings

### Output sanitization / squad chat XSS

I specifically checked the squad chat path because that was called out in scope. The reviewed dashboard component appears to render message text through normal React text nodes, not `dangerouslySetInnerHTML`, which means React escapes content by default.

Because of that, I did **not** record a stored-XSS finding from the evidence reviewed in this audit.

### Path traversal in drift baseline reset

`resetBaselines()` uses `toFileSegment(agentId)` before matching/deleting baseline files:

```ts
if (!file.startsWith(`${this.toFileSegment(agentId)}__`)) return false;
return file === `${this.toFileSegment(agentId)}__${metric}.json`;
```

That path is safer than the alert acknowledgement path and did not warrant a separate finding.
