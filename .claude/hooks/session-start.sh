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

# Toolchain reconciliation. The remote web image ships Node 22 + pnpm
# 10.x, but this repo pins Node 24 + pnpm >=11 (engines / packageManager
# in package.json). The base image carries only node20/21/22 — Node 24
# is not installable here — and the workspace builds, typechecks, and
# tests cleanly on Node 22, so we bridge the gap rather than fail setup:
#
#   1. Run pnpm via corepack, which honours the `packageManager` pin
#      (pnpm@11.5.0). A bare `pnpm` resolves to the image's system pnpm
#      10.x, which trips ERR_PNPM_UNSUPPORTED_ENGINE against the
#      `engines.pnpm: >=11` constraint AND would resolve the lockfile
#      with the wrong major.
#   2. Disable engine-strict so the Node 22-vs-24 minor mismatch only
#      WARNs instead of aborting. CI (.github/workflows/ci.yml) and the
#      Railway deploy still run Node 24, so production parity is intact;
#      this relaxation is scoped to the web-session sandbox.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export npm_config_engine_strict=false

# Prefer corepack (gets pnpm 11.5.0 from the packageManager pin); fall
# back to a bare pnpm if corepack is somehow unavailable.
if corepack --version >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  PNPM=(pnpm)
fi

"${PNPM[@]}" install --frozen-lockfile
