#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
QMD_BIN="${QMD_BIN:-qmd}"
STORAGE_ROOT="${DATA_DIR:-${VERITAS_DATA_DIR:-$ROOT_DIR}}"
TASKS_ACTIVE_DIR="${VERITAS_SEARCH_TASKS_ACTIVE_DIR:-$STORAGE_ROOT/tasks/active}"
TASKS_ARCHIVE_DIR="${VERITAS_SEARCH_TASKS_ARCHIVE_DIR:-$STORAGE_ROOT/tasks/archive}"
DOCS_DIR="${VERITAS_SEARCH_DOCS_DIR:-$ROOT_DIR/docs}"

if ! command -v "$QMD_BIN" >/dev/null 2>&1; then
  echo "qmd CLI not found. Install with: npm install -g @tobilu/qmd" >&2
  exit 1
fi

cd "$ROOT_DIR"

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
"$QMD_BIN" embed
