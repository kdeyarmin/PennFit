#!/usr/bin/env bash
# Enforces the dependency rules documented in docs/resupply/ARCHITECTURE.md.
#
# Each rule is a forbidden import edge expressed as a ripgrep pattern. If
# any matches, we exit non-zero and the validation step fails.
#
# This is intentionally cheap to read — when a rule fires, the developer
# should be able to see exactly why their commit was rejected without
# digging into a parser.
#
# Usage:
#   bash scripts/check-resupply-architecture.sh
#       Run against the repo root (default).
#
#   bash scripts/check-resupply-architecture.sh --self-test
#       Run the negative-test harness: build a fixture tree with known
#       violations, point the check at it, and assert it fails. Then
#       remove the violations and assert it passes. Used by the
#       resupply-check validation step to prevent regressions in the
#       checker itself (the architect review caught a bug where Rule 1
#       computed offending matches but never failed on them).
#
#   RESUPPLY_CHECK_ROOT=/some/dir bash scripts/check-resupply-architecture.sh
#       Run against an arbitrary tree (used by --self-test).

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${RESUPPLY_CHECK_ROOT:-$REPO_ROOT}"
cd "$ROOT"

errors=0

fail() {
  echo "ARCHITECTURE VIOLATION: $1" >&2
  errors=$((errors + 1))
}

# Defensive ripgrep type coverage: include .ts/.tsx (default) plus .mts/.cts
# so future contributors can't bypass the gate by renaming a file.
RG_TYPES=(--type-add 'tsall:*.ts' --type-add 'tsall:*.tsx' \
          --type-add 'tsall:*.mts' --type-add 'tsall:*.cts' --type tsall)

# Helper: scan one source dir for forbidden import strings.
# Args: <source dir> <human description> <regex>...
# Each regex is matched against TS/TSX/MTS/CTS files. Patterns should be
# quote-agnostic (use ['\"]) so single- and double-quoted imports both fail.
forbid_imports_in() {
  local dir="$1"; shift
  local desc="$1"; shift
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  for pat in "$@"; do
    if rg --no-messages -l "${RG_TYPES[@]}" -e "$pat" "$dir" >/dev/null 2>&1; then
      local matches
      matches="$(rg --no-messages "${RG_TYPES[@]}" -n -e "$pat" "$dir" | head -20 || true)"
      fail "$desc — pattern: $pat"
      if [[ -n "$matches" ]]; then
        echo "$matches" | sed 's/^/    /' >&2
      fi
    fi
  done
}

# Rule 1: resupply-contracts may only import zod (or relative paths).
# Positive whitelist instead of negative lookahead because ripgrep's
# default regex (RE2) does not support lookaheads. We grep every
# non-relative import and subtract zod; whatever is left is a violation.
if [[ -d lib/resupply-contracts/src ]]; then
  # Capture every `from "X"` / `from 'X'` where X does NOT start with '.'.
  bad="$(rg --no-messages -n "${RG_TYPES[@]}" \
    -e "from ['\"]([^.'\"][^'\"]*)['\"]" \
    lib/resupply-contracts/src 2>/dev/null \
    | grep -Ev "from ['\"]zod['\"]" \
    || true)"
  if [[ -n "$bad" ]]; then
    fail "lib/resupply-contracts may only import 'zod' or relative paths"
    echo "$bad" | sed 's/^/    /' >&2
  fi
fi

# Rule 2: resupply-domain must be pure — no I/O packages, no vendor SDKs,
# and no testing utilities.
forbid_imports_in lib/resupply-domain/src \
  "lib/resupply-domain must not import I/O packages (db/telecom/ai/audit) or testing utilities" \
  '@workspace/resupply-db' \
  '@workspace/resupply-telecom' \
  '@workspace/resupply-ai' \
  '@workspace/resupply-audit' \
  '@workspace/resupply-testing' \
  "['\"]drizzle-orm" \
  "['\"]pg['\"]" \
  "['\"]@anthropic-ai/sdk['\"]" \
  "['\"]twilio['\"]" \
  "['\"]@sendgrid/mail['\"]"

# Rule 3: resupply-db may not import vendor adapters.
forbid_imports_in lib/resupply-db/src \
  "lib/resupply-db must not import vendor adapters (telecom/ai)" \
  '@workspace/resupply-telecom' \
  '@workspace/resupply-ai'

# Rule 4: telecom and ai must not import each other.
forbid_imports_in lib/resupply-telecom/src \
  "lib/resupply-telecom must not import lib/resupply-ai (factor shared logic into resupply-domain)" \
  '@workspace/resupply-ai'
forbid_imports_in lib/resupply-ai/src \
  "lib/resupply-ai must not import lib/resupply-telecom (factor shared logic into resupply-domain)" \
  '@workspace/resupply-telecom'

# Rule 5: resupply-testing must not be imported by production code (api,
# worker, dashboard, or any non-test file in libs).
for prod in artifacts/resupply-api/src artifacts/resupply-worker/src artifacts/resupply-dashboard/src; do
  forbid_imports_in "$prod" \
    "$prod must not import @workspace/resupply-testing (testing helpers are devDeps only)" \
    '@workspace/resupply-testing'
done
for libdir in lib/resupply-contracts/src lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src; do
  if [[ -d "$libdir" ]]; then
    bad="$(rg --no-messages -l "${RG_TYPES[@]}" \
      -e '@workspace/resupply-testing' "$libdir" 2>/dev/null \
      | rg -v '\.test\.|__tests__|/test/' || true)"
    if [[ -n "$bad" ]]; then
      fail "$libdir: non-test files import @workspace/resupply-testing"
      echo "$bad" | sed 's/^/    /' >&2
    fi
  fi
done

# Rule 6: resupply packages must not import Penn Fit's lib/db, lib/api-zod,
# or lib/api-client-react. Different product, different schema. The
# dashboard now ships @workspace/resupply-api-client and is included in
# this sweep — the Phase 0 carve-out documented in earlier revisions of
# docs/resupply/ARCHITECTURE.md was retired in Phase 4.
# Quote-agnostic: forbid both single- and double-quoted forms.
for resdir in lib/resupply-contracts/src lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src lib/resupply-testing/src artifacts/resupply-api/src artifacts/resupply-worker/src artifacts/resupply-dashboard/src; do
  forbid_imports_in "$resdir" \
    "$resdir must not import Penn Fit packages (use the resupply-* equivalents)" \
    "@workspace/db['\"]" \
    "@workspace/api-zod['\"]" \
    "@workspace/api-client-react['\"]"
done

if [[ "$errors" -gt 0 ]]; then
  echo "" >&2
  echo "$errors architecture rule violation(s). See docs/resupply/ARCHITECTURE.md for the full ruleset." >&2
  exit 1
fi

echo "Resupply architecture check passed."
