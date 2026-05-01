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
cd "$CLAUDE_PROJECT_DIR"

pnpm install --frozen-lockfile
