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

# Toolchain reconciliation. This repo pins Node 24 + pnpm@11.7.0 (engines /
# packageManager in package.json), but the remote web image's default `node`
# on PATH is v22 (/opt/node22/bin) and its system pnpm is 10.x. Node 24 is
# NOT baked into the base image — but it IS installable at session start via
# the image's nvm (network reaches nodejs.org), so we install it and make
# it (plus a corepack-managed pnpm 11) the default toolchain for the whole
# session, matching CI and the Railway deploy exactly.
#
# How the upgrade reaches every later shell: Bash tool calls are
# non-login/non-interactive — they don't re-source /etc/profile or ~/.bashrc,
# they inherit PATH from the harness parent. That inherited PATH already
# lists ~/.local/bin AHEAD of /opt/node22/bin, so symlinking the Node 24
# binaries (and a corepack pnpm shim) into ~/.local/bin makes `node`/`pnpm`
# resolve to 24/11 in every subsequent shell without touching the image.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

LOCAL_BIN="${HOME:-/root}/.local/bin"
mkdir -p "$LOCAL_BIN"

# Install + activate Node 24 via the image's nvm. Keep going on failure
# (e.g. offline) so setup still completes on the image's Node 22 rather
# than aborting the whole session.
#
# Resilience: `nvm install 24` needs nodejs.org, and a cold-container DNS
# blip at session start can make that one call fail — which historically
# dropped the WHOLE session back to Node 22 even though Node 24 may already
# be cached on disk from a prior run. So we (a) retry the install a few
# times, and (b) treat an already-installed Node 24 (`nvm which 24`) as
# success even when every fresh install attempt fails offline.
node_upgraded=false
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"

  # Try to install/refresh Node 24, retrying a couple of times to ride out
  # a transient cold-start network failure. Non-fatal: a cached install
  # (checked next) can still carry the session.
  for attempt in 1 2 3; do
    nvm install 24 >/dev/null 2>&1 && break
    sleep $((attempt * 2))
  done

  # Resolve a usable Node 24 whether it was just installed or already
  # cached. `nvm which 24` prints the binary path for the newest matching
  # version and exits non-zero if none is installed.
  if NODE24="$(nvm which 24 2>/dev/null)" && [ -x "$NODE24" ]; then
    nvm alias default 24 >/dev/null 2>&1 || true
    NODE24_BIN="$(dirname "$NODE24")"
    for b in node npm npx corepack; do
      [ -x "$NODE24_BIN/$b" ] && ln -sf "$NODE24_BIN/$b" "$LOCAL_BIN/$b"
    done
    # corepack pnpm shim → resolves the pnpm version from the
    # packageManager pin in package.json at run time.
    "$NODE24_BIN/corepack" enable --install-directory "$LOCAL_BIN" pnpm >/dev/null 2>&1 || true
    node_upgraded=true
  fi
fi

export PATH="$LOCAL_BIN:$PATH"

if [ "$node_upgraded" = true ]; then
  echo "[session-start] Node $(node --version) / pnpm $(pnpm --version)"
else
  # Fallback: Node 24 unavailable (offline). Bridge on the image's Node 22
  # via corepack pnpm 11, relaxing engine-strict so the Node minor mismatch
  # only WARNs instead of aborting. The workspace builds/tests on Node 22.
  echo "[session-start] WARN: Node 24 install unavailable; bridging on $(node --version)"
  export npm_config_engine_strict=false
fi

# Prefer corepack (gets the pinned pnpm from the packageManager field); fall
# back to a bare pnpm if corepack is somehow unavailable.
if corepack --version >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  PNPM=(pnpm)
fi

"${PNPM[@]}" install --frozen-lockfile
