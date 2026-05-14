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
"$QMD_BIN" collection add "$TASKS_ACTIVE_DIR" --name tasks-active
"$QMD_BIN" collection add "$TASKS_ARCHIVE_DIR" --name tasks-archive
"$QMD_BIN" collection add "$DOCS_DIR" --name docs
"$QMD_BIN" update
"$QMD_BIN" embed
