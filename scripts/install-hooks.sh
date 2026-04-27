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

SOURCE_HOOK="$REPO_ROOT/scripts/git-hooks/pre-commit"
TARGET_HOOK="$HOOKS_DIR/pre-commit"

if [[ ! -f "$SOURCE_HOOK" ]]; then
  printf 'install-hooks: source hook missing at %s\n' "$SOURCE_HOOK" >&2
  exit 1
fi

# If a non-managed pre-commit already exists (e.g. one a contributor
# wrote themselves), back it up the first time we install instead of
# silently overwriting it. We identify our own hook by a marker line
# baked into scripts/git-hooks/pre-commit.
MARKER="# managed by scripts/install-hooks.sh"
if [[ -f "$TARGET_HOOK" ]] && ! grep -qF "$MARKER" "$TARGET_HOOK"; then
  backup="$TARGET_HOOK.replaced.$(date +%s)"
  mv "$TARGET_HOOK" "$backup"
  printf 'install-hooks: existing pre-commit moved to %s\n' "$backup" >&2
fi

cp "$SOURCE_HOOK" "$TARGET_HOOK"
chmod +x "$TARGET_HOOK"

printf 'install-hooks: pre-commit hook installed at %s\n' "$TARGET_HOOK"
