#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments. Local
# checkouts already have whatever toolchain the developer prefers.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The setup script's cwd may be /home/user (no package.json), which
# breaks the corepack-managed `pnpm` shim with
# ERR_PNPM_NO_PKG_MANIFEST. cd into the repo so corepack finds the
# workspace manifest before invoking pnpm.
#
# CLAUDE_PROJECT_DIR is normally exported by Claude Code, but the
# remote setup wrapper may invoke this hook before that happens
# (and it runs with `set -u`, so a bare reference would abort with
# "unbound variable"). Fall back to `git rev-parse` and finally to
# the script's own directory so the hook is robust to either entry
# point.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$PROJECT_DIR"

pnpm install --frozen-lockfile
