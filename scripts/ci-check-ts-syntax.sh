#!/usr/bin/env bash
# CI backstop for the TS/TSX syntax check (Task #82).
#
# The pre-commit hook at scripts/git-hooks/pre-commit runs
# scripts/check-ts-syntax.mjs against staged TS/TSX files so malformed
# hook calls (TS1xxx-class syntax errors) get caught locally in
# milliseconds. That hook is the fast path, but it can be bypassed
# with `git commit --no-verify` or `SKIP_HOOKS=1`, and contributors
# who haven't run `scripts/install-hooks.sh` yet won't have it
# installed at all. This script wires the same checker into the
# validation pipeline so syntax errors cannot reach main even when
# the local hook is skipped.
#
# What it does:
#   1. Runs `node scripts/check-ts-syntax.mjs --self-test` so the
#      checker itself can't silently regress (a broken self-test means
#      the pre-commit hook is broken too).
#   2. Collects every tracked .ts/.tsx/.mts/.cts file under
#      artifacts/, lib/, and scripts/src/ (excluding .d.ts) and pipes
#      them into scripts/check-ts-syntax.mjs in one batch.
#
# Exits non-zero on any syntax error or self-test failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

printf '[ci-check-ts-syntax] Running checker self-test…\n' >&2
node scripts/check-ts-syntax.mjs --self-test

printf '[ci-check-ts-syntax] Collecting tracked TS/TSX files…\n' >&2
# git ls-files honors .gitignore and ignores untracked junk, so we
# never accidentally lint build output or someone's local scratch
# files. The pathspecs mirror the pre-commit hook's dispatch.
mapfile -t files < <(
  git ls-files \
    'artifacts/*.ts' 'artifacts/*.tsx' 'artifacts/*.mts' 'artifacts/*.cts' \
    'lib/*.ts' 'lib/*.tsx' 'lib/*.mts' 'lib/*.cts' \
    'scripts/src/*.ts' 'scripts/src/*.tsx' 'scripts/src/*.mts' 'scripts/src/*.cts' \
    | grep -v '\.d\.ts$' || true
)

if [[ ${#files[@]} -eq 0 ]]; then
  printf '[ci-check-ts-syntax] No eligible TS/TSX files found — nothing to check.\n' >&2
  exit 0
fi

printf '[ci-check-ts-syntax] Parsing %d file(s)…\n' "${#files[@]}" >&2
node scripts/check-ts-syntax.mjs "${files[@]}"

printf '[ci-check-ts-syntax] OK — no syntax errors.\n' >&2
