#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
QMD_BIN="${QMD_BIN:-qmd}"

if ! command -v "$QMD_BIN" >/dev/null 2>&1; then
  echo "qmd CLI not found. Install with: npm install -g @tobilu/qmd" >&2
  exit 1
fi

"$QMD_BIN" collection add "$ROOT_DIR/tasks/active" --name tasks-active
"$QMD_BIN" collection add "$ROOT_DIR/tasks/archive" --name tasks-archive
"$QMD_BIN" collection add "$ROOT_DIR/docs" --name docs
"$QMD_BIN" update
"$QMD_BIN" embed
