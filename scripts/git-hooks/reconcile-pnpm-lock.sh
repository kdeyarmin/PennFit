#!/usr/bin/env bash
#
# Reconcile pnpm-lock.yaml after a merge or rebase. Invoked by the
# post-merge and post-rewrite git hooks (both installed by
# scripts/install-hooks.sh).
#
# The pnpm-lock merge driver (merge-pnpm-lock.sh) resolves a lockfile
# conflict by taking one side outright. That keeps merges from halting,
# but the chosen side can be stale against the merged package.json set.
# This step re-runs `pnpm install` whenever the just-completed operation
# changed pnpm-lock.yaml, so the committed lockfile ends up matching
# package.json instead of whichever side the driver happened to pick.
#
# Best-effort and non-fatal by design: a failure here must NEVER break
# the user's merge/rebase. Worst case the lockfile is left as the driver
# picked it and CI's `pnpm install --frozen-lockfile` flags it.
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$repo_root" || exit 0

# Only act when we can POSITIVELY confirm the operation changed the
# lockfile. ORIG_HEAD is set by both `git merge` and `git rebase` to the
# pre-operation tip. If it's missing we can't tell what changed, so do
# nothing rather than trigger a surprise full install.
git rev-parse --verify --quiet ORIG_HEAD >/dev/null 2>&1 || exit 0
git diff --quiet ORIG_HEAD HEAD -- pnpm-lock.yaml 2>/dev/null && exit 0

command -v pnpm >/dev/null 2>&1 || exit 0

printf '[git-hook] pnpm-lock.yaml changed by the merge/rebase — running `pnpm install` to reconcile it…\n' >&2
if ! pnpm install --prefer-offline >&2; then
  printf '[git-hook] `pnpm install` failed; reconcile pnpm-lock.yaml manually before pushing.\n' >&2
fi
exit 0
