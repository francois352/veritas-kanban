# NeuroClaw Customizations — Veritas Kanban

This file documents all customizations applied to our Veritas Kanban fork
(upstream: `BradGroux/veritas-kanban` v3.3.3).

## Path Prefix Patch

**Purpose:** Run Veritas behind Traefik at `/kanban/` instead of root `/`.

**Files modified:**

- `Dockerfile` — build arg for path prefix
- `web/vite.config.ts` — base path config
- `web/src/main.tsx` — router basename
- `web/src/lib/config.ts` — API URL prefix
- `web/src/lib/api/helpers.ts` — fetch URL prefix
- `web/src/hooks/useWebSocket.ts` — WebSocket URL prefix
- `web/src/components/settings/tabs/SecurityTab.tsx` — login form action

**Patch file:** `neuroclaw-path-prefix.patch`

## Dispatch Service

**File:** `server/src/services/dispatch-service.ts`

**Purpose:** Bridges Veritas task assignments to the AI Team Redis Streams protocol.
When a task is created or reassigned to an AI agent, publishes a `kanban_dispatch`
message to `bot:messages` Redis stream. Agents consume via their coordination layer.

**Protocol:** `ai-team-protocol-v1` (same as `shared/coordination.js` in moltbot)

**Behavior:**

- Checks agent registry to determine if assignee is an AI agent
- Skips dispatch for `origin: 'agent'` (prevents loops)
- Posts audit comment to task after successful dispatch
- Fire-and-forget: never blocks the API call
- Auto-trims stream at ~1000 entries

**Env vars:**

- `REDIS_URL` — Redis connection string (required)
- `KANBAN_API_URL` — Kanban API base URL (for audit comments)
- `KANBAN_API_TOKEN` — Bearer token for Kanban API

## Execution Dashboard (Council Hub)

**Container:** `council-hub`
**File:** `/app/council-hub/server.js`

**Endpoints:**

- `GET /api/exec-dash/fleet` — Agent fleet status with heartbeat tracking
- `GET /api/exec-dash/costs` — Cost trends over time
- `GET /api/exec-dash/delegations` — Delegation flow metrics
- `GET /api/exec-dash/tasks` — Recent tasks from Kanban API (limit clamped to 100)
- `GET /api/exec-dash/routing` — Routing stats by capability hash
- `GET /dashboard` — Execution dashboard HTML

## Hardening (2026-03-09)

1. **isAiAgent()** — Replaced hardcoded HUMANS blocklist with registry-based check
2. **Limit clamp** — `/api/exec-dash/tasks?limit=N` capped at 100
3. **Fetch timeout** — 10s AbortController on Kanban API calls from exec-dash
4. **Cost parsing** — Added NaN check + $10k sanity cap on parsed cost values
5. **Dispatch audit** — POST comment to task after successful Redis XADD

## Upstream Sync Notes

Our fork diverges from upstream. To sync:

1. Fetch upstream changes
2. Reapply path prefix patch (`neuroclaw-path-prefix.patch`)
3. Rebuild Docker image
4. Dispatch service is additive (new file), no conflict expected
