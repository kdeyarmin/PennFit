#!/usr/bin/env bash
# Installs the repo's git hooks into the local .git directory.
#
# Why this exists:
#   The validation gate (`resupply-check`) catches API spec / codegen
#   drift and architecture violations, but only after a developer
#   pushes. A pre-commit hook catches the same issues in seconds,
#   before the bad commit ever lands. Running this script wires the
#   hook into the developer's local repo.
#
# How it runs:
#   - Manually: `bash scripts/install-hooks.sh`
#   - Automatically: invoked from scripts/post-merge.sh, so any
#     contributor who merges a task picks up the hook with zero
#     manual setup. Idempotent — safe to re-run.
#
# Why a plain shell installer instead of Husky/lefthook:
#   - One file, no extra devDependency, no `prepare` script.
#   - Works in agent-managed environments where node_modules can be
#     wiped between sessions.
#   - The hook itself is a small bash script that already exists in
#     the repo; this installer just copies it into place.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v git >/dev/null 2>&1; then
  printf 'install-hooks: git not found, skipping hook install\n' >&2
  exit 0
fi

# Tolerate running from inside a tarball / non-repo checkout. We don't
# want post-merge.sh to fail just because the repo isn't a git repo
# (e.g. CI may unpack a snapshot). The hook is local-developer-only.
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'install-hooks: %s is not a git repo, skipping\n' "$REPO_ROOT" >&2
  exit 0
fi

# `git rev-parse --git-path hooks` returns either an absolute path or
# a path relative to the current working directory (which we set to
# REPO_ROOT below). Normalize either way.
HOOKS_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-path hooks)"
case "$HOOKS_DIR" in
  /*) ;;
  *)  HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;;
esac

mkdir -p "$HOOKS_DIR"

MARKER="# managed by scripts/install-hooks.sh"

install_one() {
  local name="$1"
  local source_hook="$REPO_ROOT/scripts/git-hooks/$name"
  local target_hook="$HOOKS_DIR/$name"

  if [[ ! -f "$source_hook" ]]; then
    printf 'install-hooks: source hook missing at %s\n' "$source_hook" >&2
    return 1
  fi

  # If a non-managed hook already exists (e.g. one a contributor
  # wrote themselves), back it up the first time we install instead
  # of silently overwriting it. Identify our own hook by a marker
  # line baked into the source.
  if [[ -f "$target_hook" ]] && ! grep -qF "$MARKER" "$target_hook"; then
    local backup="$target_hook.replaced.$(date +%s)"
    mv "$target_hook" "$backup"
    printf 'install-hooks: existing %s moved to %s\n' "$name" "$backup" >&2
  fi

  cp "$source_hook" "$target_hook"
  chmod +x "$target_hook"
  printf 'install-hooks: %s hook installed at %s\n' "$name" "$target_hook"
}

install_one pre-commit
install_one pre-push
