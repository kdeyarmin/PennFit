#!/usr/bin/env bash
# Non-blocking drift warning for the local `main` branch.
#
# CLAUDE.md describes a contract that the pre-commit hook prints a
# warning when local `main` is more than 10 commits behind the
# canonical ref (`subrepl-3ppc2e03/main` on Replit, which points at
# `main` on github.com/kdeyarmin/PennFit). Until this script was
# added that warning lived in CLAUDE.md only; this is the
# implementation.
#
# Exits 0 unconditionally — pre-commit hooks that fail block the
# commit, and the original design called this advisory, not
# enforcing. The threshold (10) matches the documented contract.
#
# Skip via SKIP_HOOKS=1 (matches the convention CLAUDE.md
# already documents for the rest of the pre-commit chain).

set -euo pipefail

if [[ "${SKIP_HOOKS:-0}" == "1" ]]; then
  exit 0
fi

# Try the Replit remote-tracking name first; fall back to the
# GitHub remote so this works from a vanilla clone too. Silent
# failure is fine — we don't want to nag developers whose checkout
# doesn't have either remote configured.
CANONICAL_REF=""
for ref in subrepl-3ppc2e03/main origin/main; do
  if git rev-parse --verify --quiet "$ref" >/dev/null; then
    CANONICAL_REF="$ref"
    break
  fi
done
if [[ -z "$CANONICAL_REF" ]]; then
  exit 0
fi

# No local `main`? Nothing to compare. Most working trees check out
# a feature branch; the warning only matters if `main` itself is
# falling behind.
if ! git rev-parse --verify --quiet main >/dev/null; then
  exit 0
fi

BEHIND=$(git rev-list --count "main..$CANONICAL_REF")
THRESHOLD=10

if (( BEHIND > THRESHOLD )); then
  printf '\n' >&2
  printf '⚠️  Local `main` is %d commits behind %s (threshold: %d).\n' \
    "$BEHIND" "$CANONICAL_REF" "$THRESHOLD" >&2
  printf '   See CLAUDE.md → "Start-of-session checklist" for the realign steps.\n' >&2
  printf '   (Warning only — commit not blocked. Set SKIP_HOOKS=1 to silence.)\n' >&2
  printf '\n' >&2
fi
