#!/usr/bin/env bash
# Enforces the dependency rules documented in docs/resupply/ARCHITECTURE.md.
#
# Each rule is a forbidden import edge expressed as a ripgrep pattern. If
# any matches, we exit non-zero and the validation step fails.
#
# This is intentionally cheap to read — when a rule fires, the developer
# should be able to see exactly why their commit was rejected without
# digging into a parser.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

errors=0

fail() {
  echo "ARCHITECTURE VIOLATION: $1" >&2
  errors=$((errors + 1))
}

# Helper: scan one source dir for forbidden import strings.
# Args: <source dir> <human description> <pattern> [<pattern>...]
forbid_imports_in() {
  local dir="$1"; shift
  local desc="$1"; shift
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  for pat in "$@"; do
    if rg --no-messages -l --type ts --type tsx -e "$pat" "$dir" >/dev/null 2>&1; then
      local matches
      matches="$(rg --no-messages --type ts --type tsx -n -e "$pat" "$dir" | head -20 || true)"
      fail "$desc — pattern: $pat"
      if [[ -n "$matches" ]]; then
        echo "$matches" | sed 's/^/    /' >&2
      fi
    fi
  done
}

# Rule 1: resupply-contracts may only import zod.
if [[ -d lib/resupply-contracts/src ]]; then
  bad="$(rg --no-messages -n --type ts --type tsx \
    -e '^import .* from "(?!zod"|\./|\.\./)' \
    lib/resupply-contracts/src 2>/dev/null || true)"
  # Coarser check: forbid any @workspace/* import from contracts.
  forbid_imports_in lib/resupply-contracts/src \
    "lib/resupply-contracts must not import from any @workspace/* package" \
    '@workspace/'
fi

# Rule 2: resupply-domain may not import db, telecom, ai, audit, or testing.
forbid_imports_in lib/resupply-domain/src \
  "lib/resupply-domain must not import I/O packages (db/telecom/ai/audit) or testing utilities" \
  '@workspace/resupply-db' \
  '@workspace/resupply-telecom' \
  '@workspace/resupply-ai' \
  '@workspace/resupply-audit' \
  '@workspace/resupply-testing' \
  '"drizzle-orm' \
  '"pg"' \
  '"@anthropic-ai/sdk"' \
  '"twilio"' \
  '"@sendgrid/mail"'

# Rule 3: resupply-db may not import telecom or ai.
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
    bad="$(rg --no-messages -l --type ts --type tsx \
      -e '@workspace/resupply-testing' "$libdir" 2>/dev/null \
      | rg -v '\.test\.|__tests__|/test/' || true)"
    if [[ -n "$bad" ]]; then
      fail "$libdir: non-test files import @workspace/resupply-testing"
      echo "$bad" | sed 's/^/    /' >&2
    fi
  fi
done

# Rule 6: resupply packages must not import Penn Fit's lib/db, lib/api-zod,
# or lib/api-client-react. Different product, different schema.
for resdir in lib/resupply-contracts/src lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src lib/resupply-testing/src artifacts/resupply-api/src artifacts/resupply-worker/src; do
  forbid_imports_in "$resdir" \
    "$resdir must not import Penn Fit packages (use the resupply-* equivalents)" \
    '@workspace/db"' \
    '@workspace/api-zod"' \
    '@workspace/api-client-react"'
done
# Dashboard is allowed @workspace/api-client-react TEMPORARILY (Phase 0
# scaffold default). Phase 4 swaps it for a resupply-specific client and
# this exception goes away.

if [[ "$errors" -gt 0 ]]; then
  echo "" >&2
  echo "$errors architecture rule violation(s). See docs/resupply/ARCHITECTURE.md for the full ruleset." >&2
  exit 1
fi

echo "Resupply architecture check passed."
