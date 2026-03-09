# CLAUDE.md — Agent Guidelines for Veritas Kanban

This file defines project-specific rules, context, and lessons learned for AI agents working on Veritas Kanban. Update it after every mistake, discovery, or workflow change.

> **Last updated:** 2026-03-09 (v3.3.3)
> **Freshness check:** Review monthly or after major releases

---

## Project Context

**Veritas Kanban** is an open-source AI-native task management system (upstream: `BradGroux/veritas-kanban`). Designed for humans + AI agents to collaborate through a shared board, CLI, MCP, and API.

- **Primary language:** TypeScript (strict mode)
- **Monorepo:** pnpm workspaces — `server/`, `web/`, `cli/`, `shared/`, `mcp/`
- **Build:** Node 22+, pnpm 9+
- **Test:** Vitest (server + MCP), React Testing Library (web), Playwright (E2E), k6 (load)
- **Style:** ESLint 9 + Prettier, conventional commits, Husky pre-commit hooks
- **UI:** React 19 + Tailwind CSS 4 + shadcn/ui (Radix primitives) + @dnd-kit

---

## Fork Policy (NeuroClaw)

This is a **thin fork**. Minimize custom code inside the fork to reduce rebase pain.

| Belongs in the fork                               | Does NOT belong in the fork                  |
| ------------------------------------------------- | -------------------------------------------- |
| Path prefix patch (until upstream PR #189 merges) | NeuroClaw-specific services (dispatch, etc.) |
| Bug fixes submitted as upstream PRs               | Custom workflow definitions                  |
| Config/enforcement settings (data, not code)      | AI Team protocol handlers                    |

- **NEVER add NeuroClaw-specific business logic** to `server/src/services/` — use sidecars in `llm-telegram-bots/`
- Fork-specific docs go in `NEUROCLAW.md`, not in upstream docs
- Patch file: `neuroclaw-path-prefix.patch` (refresh after any path prefix changes)

---

## Architecture Rules

### Server (Express 5 + TypeScript)

- All routes go through centralized middleware in `server/src/middleware/`
- Auth: JWT + API keys, localhost bypass for dev (`VERITAS_AUTH_LOCALHOST_BYPASS=true`)
- Storage: Abstract via `storage/interfaces.ts` — **never import `fs` directly in services**
- Error handling: Use typed errors from `middleware/error-handler.ts`:
  - `UnauthorizedError`, `ForbiddenError`, `BadRequestError`, `NotFoundError`, `ValidationError`, `ConflictError`, `InternalError`
- Pagination: Use `sendPaginated(res, items, {page, limit, total})`
- Response envelope: `{ success: true/false, data?: T, error?: {...}, meta?: {...} }`
- Validation: Zod schemas in `server/src/schemas/` — validate all user input
- Logging: Pino structured JSON (`createLogger('component')`) — sensitive fields auto-redacted via `lib/redact.ts`
- Security: Helmet CSP, rate limiting (tiered: auth 10/15min, write 60/min, read 300/min), SSRF protection for webhooks

### Web (React 19 + Vite 7)

- State: Zustand stores, no prop drilling past 2 levels
- Data fetching: TanStack React Query — use `onMutate` for optimistic updates
- Realtime: WebSocket via `useRealtimeUpdates` hooks — don't add polling
- Styling: Tailwind CSS 4, component-scoped styles
- Components: shadcn/ui (Radix primitives) — don't mix with other UI libraries
- Drag & drop: @dnd-kit — don't introduce alternative DnD libraries
- Lazy loading: `React.lazy()` for ActivityFeed, BacklogPage, ArchivePage, TemplatesPage, WorkflowsPage

### CLI (Commander.js)

- Every command mirrors an API endpoint
- JSON output via `--json` flag for scripting
- Use `chalk` for colored output
- Bin entrypoint: `vk`

### MCP Server (@modelcontextprotocol/sdk)

- 26 tools across 6 modules: tasks, agents, sprints, automation, notifications, summary
- Transport: stdio (default), HTTP via Hono
- All tool inputs validated with Zod

---

## Deployment (NeuroClaw VPS)

- **Path:** Runs at `/kanban/` behind Traefik (not root `/`)
- **Patches:** 6-file path prefix patch — global `window.fetch` interceptor in `main.tsx`
- **Docker:** Multi-stage build, non-root user (`veritas:nodejs`, uid 1001)
- **Volumes:** `veritas-data:/app/data` (tasks), `veritas-config:/app/.veritas-kanban` (config, enforcement, sprints)
- **Gotcha:** `docker cp` copies as root — must `chown -R veritas:nodejs` after any file copy
- **Health:** `GET /kanban/health`

---

## Enforcement Gates

3 of 6 active:

- `closingComments` ✅ — can't mark done without summary comment
- `autoTimeTracking` ✅ — timers auto-start/stop on status change
- `autoTelemetry` ✅ — run.\* events emit automatically
- `reviewGate` ❌ — disabled (requires review scores agents don't set)
- `squadChat` ❌ — disabled
- `orchestratorDelegation` ❌ — disabled

Settings persist in `veritas-config` volume (fixed 2026-03-09).

---

## Code Quality Gates

1. **No hardcoded secrets** — use environment variables
2. **All user input validated** — use Zod schemas in `server/src/schemas/`
3. **Path traversal prevention** — use `validatePathSegment()` from security module
4. **Tests for new features** — aim for >80% coverage on critical paths
5. **Storage abstraction enforced** — services use `storage/interfaces.ts`, never direct `fs`

---

## Common Mistakes (Don't Repeat These)

### Security

- ❌ Forgot global middleware — flagged missing per-route auth that was already in `app.use()`
- ❌ Used `path.join()` without validation — allows `../` traversal
- ✅ Always check `validatePathSegment()` for any user-supplied path component

### Architecture

- ❌ Imported `fs` directly in service files — breaks storage abstraction
- ❌ Added polling when WebSocket hook existed — use `useRealtimeAgentStatus`
- ❌ Frontend interface didn't match server response (e.g., `totalAgents` vs `total`)
- ❌ Added NeuroClaw-specific service inside the fork — increases merge conflicts
- ✅ Check for existing hooks/services before creating new ones
- ✅ Server response format is source of truth — frontend interfaces must match exactly
- ✅ NeuroClaw-specific logic goes in sidecars, not in the fork

### Multi-Agent

- Agent registry is file-based at `.veritas-kanban/agent-registry.json`
- Heartbeat timeout: 5 min (configurable). Stale check interval: 1 min
- Activity data uses `status-history` (not `activity.json`) as source of truth
- 5 registered agents: alan, claude-code, codex, francois, gemini

### Dependencies API

- ❌ `blocks` is the inverse of `depends_on` — traversing both in cycle detection creates false positives
- ✅ Cycle detection must only traverse `depends_on` edges (the canonical direction)
- Fix: upstream PR #193 (pending merge)

### Testing

- ❌ Used wrong field in backfilled events (`status: "success"` vs `success: true`)
- ✅ Match actual runtime schema exactly in test fixtures

---

## Conventions

### Naming

- Files: `kebab-case.ts`
- Components: `PascalCase.tsx`
- Variables/functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Task IDs: `task_YYYYMMDD_XXXXXX` (date + nanoid)

### Git

- Branch: `feat/description-issue-number`, `fix/description-issue-number`
- Commit: Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`)
- PR: Always reference issue number
- Fork remote: `fork` (francois352/veritas-kanban)
- Upstream remote: `origin` (BradGroux/veritas-kanban)

### Task Workflow (via CLI)

1. Start work: `vk begin <id>` (sets in-progress + starts timer + agent working)
2. Work, commit, push
3. Complete: `vk done <id> "summary"` (stops timer + marks done + comment + agent idle)
4. Block: `vk block <id> "reason"` / Unblock: `vk unblock <id>`

---

## File Locations

| What                | Where                                     |
| ------------------- | ----------------------------------------- |
| API routes          | `server/src/routes/` (56 files)           |
| Services            | `server/src/services/` (61 files)         |
| Schemas             | `server/src/schemas/`                     |
| Storage             | `server/src/storage/`                     |
| Middleware          | `server/src/middleware/`                  |
| Config              | `server/src/config/`                      |
| React components    | `web/src/components/` (17 subdirectories) |
| Zustand stores      | `web/src/stores/`                         |
| CLI commands        | `cli/src/commands/`                       |
| Shared types        | `shared/src/`                             |
| MCP tools           | `mcp/src/tools/` (6 modules)              |
| Prompts             | `prompt-registry/`                        |
| SOPs                | `docs/SOP-*.md`                           |
| Agent registry      | `.veritas-kanban/agent-registry.json`     |
| Telemetry events    | `.veritas-kanban/telemetry/`              |
| Fork customizations | `NEUROCLAW.md`                            |
| Path prefix patch   | `neuroclaw-path-prefix.patch`             |

---

## Upstream PRs (as of 2026-03-09)

7 open PRs, none merged yet. Strategy: wait 2 weeks, then pivot.

| PR   | Type                              | Impact                                |
| ---- | --------------------------------- | ------------------------------------- |
| #189 | feat: VITE_BASE_PATH              | Eliminates 6 of 7 path prefix patches |
| #191 | fix: comment WebSocket broadcasts | Real-time comment updates             |
| #192 | docs: Traefik deployment          | Helps other sub-path deployers        |
| #193 | fix: dependency cycle detection   | Fixes broken Dependencies API         |
| #194 | fix: CORS localhost ports         | Dev experience improvement            |
| #195 | feat: system health status bar    | Dashboard monitoring                  |
| #196 | chore: shadcn/ui v4 upgrade       | Component library update              |

---

## When to Update This File

- After a bug that could have been prevented by a rule
- After discovering a pattern that should be standard
- After pulling upstream changes that affect architecture
- Monthly freshness review

---

## Credit

Structure inspired by Anthropic's CLAUDE.md convention and [BoardKit Orchestrator](https://github.com/BoardKit/orchestrator) by Monika Voutov.
