#!/usr/bin/env bash
#
# Tenant-isolation guard (multi-tenant Phase 0, workstream E1).
#
# See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md.
#
# THE INVARIANT
#   Every tenant-scoped read/write must reach Postgres through the
#   org-scoped chokepoint `getOrgScopedClient(orgId)`
#   (lib/resupply-db/src/org-scoped-client.ts), NOT through a direct
#   `getSupabaseServiceRoleClient()` call in application code. Routing
#   all access through one function is what makes tenant isolation a
#   structural property of the code rather than a per-route discipline.
#
#   This mirrors Rule 7 in check-resupply-architecture.sh (no raw `pg`
#   outside lib/resupply-db): the same "one sanctioned door" pattern,
#   one layer up.
#
# MODE — WARN (PR 0.1)
#   During the migration, app code still legitimately calls
#   `getSupabaseServiceRoleClient()` directly because no table carries an
#   enforced `org_id` yet (the per-domain backfills land in later PRs).
#   So this check currently only REPORTS offending callsites and ALWAYS
#   exits 0. It flips to FAIL mode in the Phase 0 gate PR (0.8), once the
#   wrapper is the real scoping facade and every domain has been cut over.
#   Until then it is a visibility tool + a guard against regressions in
#   its own wiring.
#
# Usage:
#   bash scripts/check-tenant-isolation.sh            # scan, warn-only
#   FAIL_ON_VIOLATION=1 bash scripts/check-tenant-isolation.sh
#                                                     # opt-in fail (CI 0.8)
#   bash scripts/check-tenant-isolation.sh --self-test
#
# Bypass (genuine emergencies): SKIP_HOOKS=1 / --no-verify, documented
# in the commit body.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  # The .test sibling lands with the FAIL-mode flip (PR 0.8); until then
  # there is nothing to self-test beyond "the scan runs", so no-op.
  echo "check-tenant-isolation: --self-test is a no-op in warn mode (PR 0.1)."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TENANT_CHECK_ROOT:-$REPO_ROOT}"
cd "$ROOT"

# Hard dependency on ripgrep. If `rg` is absent, every query matches
# nothing and the check would silently pass while enforcing nothing —
# the exact failure mode the architecture checker documents. Fail loudly
# instead (even in warn mode the missing-tool signal is worth surfacing).
if ! command -v rg >/dev/null 2>&1; then
  echo "check-tenant-isolation: ripgrep (rg) not found on PATH." >&2
  echo "  The guard cannot run without it; install ripgrep." >&2
  exit 2
fi

# Application code that must use the chokepoint. lib/resupply-db is the
# home of BOTH the service-role client and the wrapper, so it is exempt;
# the migrator and a small reviewed set of global-table callers are too.
# Globs are expressed as ripgrep --glob excludes.
EXCLUDES=(
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!lib/resupply-db/**'        # owns the client + the wrapper
  --glob '!**/*.test.ts'              # tests construct clients directly
  --glob '!scripts/**'                # operator utilities, not request paths
)

PATTERN='getSupabaseServiceRoleClient'

echo "check-tenant-isolation: scanning for direct ${PATTERN}() calls in application code…"

# `|| true` so a zero-match scan (rg exit 1) doesn't trip `set -e`.
MATCHES="$(rg --line-number --no-heading "${EXCLUDES[@]}" "$PATTERN" \
  artifacts/ lib/ 2>/dev/null || true)"

if [[ -z "$MATCHES" ]]; then
  echo "check-tenant-isolation: no direct calls found. ✅"
  exit 0
fi

COUNT="$(printf '%s\n' "$MATCHES" | grep -c . || true)"
echo
echo "check-tenant-isolation: found ${COUNT} direct ${PATTERN}() callsite(s)"
echo "in application code. These must migrate to getOrgScopedClient(orgId)"
echo "as their domain is backfilled with org_id (Phase 0 workstream C):"
echo
printf '%s\n' "$MATCHES"
echo

if [[ "${FAIL_ON_VIOLATION:-}" == "1" ]]; then
  echo "check-tenant-isolation: FAIL mode — the above are violations." >&2
  exit 1
fi

echo "check-tenant-isolation: WARN mode (PR 0.1) — reporting only, exit 0."
echo "Set FAIL_ON_VIOLATION=1 to enforce (flips on in the Phase 0 gate PR)."
exit 0
