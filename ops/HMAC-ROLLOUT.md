# HMAC Signed Actor Rollout

## Environment flags

- `KANBAN_SIG_GRACE_DAYS` controls unsigned-write grace period. Defaults to `30` (from L1.2) outside production; set lower to accelerate enforcement.
- Per-agent secrets can be configured with env vars in the form `KANBAN_HMAC_SECRET_<UPPERCASE_AGENT_ID>` (for example `KANBAN_HMAC_SECRET_CODEX`), mapped into runtime `KANBAN_HMAC_SECRETS`.
- `KANBAN_SIG_DISABLE=true` is an emergency bypass that disables signature checks and should be used only temporarily; server logs a loud error each request while enabled.

## Cutover plan

- **Phase 0 (current):** grace mode active, signed requests accepted, unsigned writes tolerated during grace.
- **Phase 1 (~day 7):** keep grace on, emit warning header and audit logs for unsigned requests.
- **Phase 2:** set grace to `0` to enforce strict rejection of unsigned writes.

## Operational notes

- Reject events are written as JSONL to `/var/log/veritas/audit-signature-reject.jsonl` for SIEM/logrotate ingestion.
- Track diagnostics via `GET /api/v1/auth/diagnostics`.
