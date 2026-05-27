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

# ---------------------------------------------------------------------------
# pnpm-lock.yaml local auto-merge (LOCAL-ONLY).
#
# Lockfile conflicts on multi-PR merge trains are the most common merge
# friction in this repo. We can't safely change how GitHub merges the
# lockfile — a custom driver can't run server-side, and a 3-way text
# auto-merge of a lockfile can corrupt it — so the committed
# .gitattributes keeps `pnpm-lock.yaml -diff merge=binary`, which makes
# GitHub treat divergence as a (safe) conflict you resolve by hand.
#
# In a local clone we can do better: register a `merge.pnpm-lock` driver
# and override the attribute in .git/info/attributes, which takes
# precedence over the committed .gitattributes and is never committed
# (so it only affects this checkout). The driver takes one side of a
# lockfile conflict and the post-merge / post-rewrite hooks below re-run
# `pnpm install` to reconcile it. Net effect: local merges and rebases
# stop halting on pnpm-lock.yaml. Idempotent.
# ---------------------------------------------------------------------------
git -C "$REPO_ROOT" config merge.pnpm-lock.name \
  "pnpm-lock.yaml — take one side, reconcile via post-merge hook"
git -C "$REPO_ROOT" config merge.pnpm-lock.driver \
  "bash '$REPO_ROOT/scripts/git-hooks/merge-pnpm-lock.sh' %O %A %B"

INFO_ATTRS="$(cd "$REPO_ROOT" && git rev-parse --git-path info/attributes)"
case "$INFO_ATTRS" in
  /*) ;;
  *)  INFO_ATTRS="$REPO_ROOT/$INFO_ATTRS" ;;
esac
mkdir -p "$(dirname "$INFO_ATTRS")"
ATTR_LINE="pnpm-lock.yaml merge=pnpm-lock"
if [[ ! -f "$INFO_ATTRS" ]] || ! grep -qxF "$ATTR_LINE" "$INFO_ATTRS"; then
  printf '%s\n' "$ATTR_LINE" >> "$INFO_ATTRS"
  printf 'install-hooks: enabled local pnpm-lock.yaml auto-merge driver\n'
fi

install_one pre-commit
install_one pre-push
install_one post-merge
install_one post-rewrite
