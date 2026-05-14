#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
QMD_BIN="${QMD_BIN:-qmd}"
SKIP_EMBED="${VERITAS_QMD_SKIP_EMBED:-false}"
SEARCH_ROOT="${VERITAS_SEARCH_ROOT:-$ROOT_DIR}"
if [[ -n "${VERITAS_SEARCH_ROOT:-}" ]]; then
  STORAGE_ROOT="$VERITAS_SEARCH_ROOT"
else
  STORAGE_ROOT="${DATA_DIR:-${VERITAS_DATA_DIR:-$ROOT_DIR}}"
fi
TASKS_ACTIVE_DIR="${VERITAS_SEARCH_TASKS_ACTIVE_DIR:-$STORAGE_ROOT/tasks/active}"
TASKS_ARCHIVE_DIR="${VERITAS_SEARCH_TASKS_ARCHIVE_DIR:-$STORAGE_ROOT/tasks/archive}"
DOCS_DIR="${VERITAS_SEARCH_DOCS_DIR:-$SEARCH_ROOT/docs}"

if ! command -v "$QMD_BIN" >/dev/null 2>&1; then
  echo "qmd CLI not found. Install with: npm install -g @tobilu/qmd" >&2
  exit 1
fi

cd "$ROOT_DIR"
mkdir -p "$TASKS_ACTIVE_DIR" "$TASKS_ARCHIVE_DIR" "$DOCS_DIR"

register_collection() {
  local name="$1"
  local dir="$2"

  "$QMD_BIN" collection remove "$name" >/dev/null 2>&1 || true
  "$QMD_BIN" collection add "$dir" --name "$name"
}

register_collection tasks-active "$TASKS_ACTIVE_DIR"
register_collection tasks-archive "$TASKS_ARCHIVE_DIR"
register_collection docs "$DOCS_DIR"
"$QMD_BIN" update

if [[ "$SKIP_EMBED" != "true" ]]; then
  "$QMD_BIN" embed
fi
