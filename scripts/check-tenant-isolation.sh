#!/usr/bin/env bash
#
# Tenant-isolation guard (multi-tenant Phase 0, workstream E1 — PR 0.8).
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
# MODE — PLAIN GATE (cutover complete)
#   The per-domain `org_id` cutover (workstream C) is DONE: zero
#   application files call `getSupabaseServiceRoleClient()` directly.
#   The historical shrinking baseline (scripts/tenant-isolation-baseline.txt)
#   reached empty and has been retired, so this is now a flat check:
#     * HARD FAIL on ANY offending file. New request/worker code must use
#       getOrgScopedClient(orgId) from the start — there is no baseline to
#       launder a new caller onto.
#   A small, reviewed set of global-table / auth callers is exempt (see
#   EXCLUDES): the migrator + client owner (lib/resupply-db), tests, the
#   tenant resolver (requireAdmin), and the global dme_organization reader
#   (identity-resolver). Adding to that allowlist is a deliberate,
#   reviewed change — not a routine escape hatch.
#
# Usage:
#   bash scripts/check-tenant-isolation.sh            # enforce (CI)
#   bash scripts/check-tenant-isolation.sh --self-test
#
# Bypass (genuine emergencies): SKIP_HOOKS=1 / --no-verify, documented
# in the commit body.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

ROOT="${TENANT_CHECK_ROOT:-$REPO_ROOT}"
cd "$ROOT"

# Hard dependency on ripgrep. If `rg` is absent, every query matches
# nothing and the check would silently pass while enforcing nothing —
# the exact failure mode the architecture checker documents. Fail loudly.
if ! command -v rg >/dev/null 2>&1; then
  echo "check-tenant-isolation: ripgrep (rg) not found on PATH." >&2
  echo "  The guard cannot run without it; install ripgrep." >&2
  exit 2
fi

# Application code that must use the chokepoint. lib/resupply-db is the
# home of BOTH the service-role client and the wrapper, so it is exempt;
# the migrator and a small reviewed set of global-table callers are too.
# Tests/specs/test-helpers construct clients directly and are exempt.
EXCLUDES=(
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!lib/resupply-db/**' # owns the client + the wrapper
  --glob '!**/*.test.ts'       # tests construct clients directly
  --glob '!**/*.test.tsx'
  --glob '!**/*.spec.ts'
  --glob '!**/test-helpers/**' # shared test fixtures
  --glob '!scripts/**'         # operator utilities, not request paths
  # requireAdmin is the tenant RESOLVER: it reads auth.users to attach
  # req.orgId, so it runs BEFORE any tenant context exists and legitimately
  # uses the unscoped service-role client (a reviewed directory-access
  # exception, like the migrator). Every other request path gets its
  # org-scoped client downstream of this middleware.
  --glob '!**/middlewares/requireAdmin.ts'
  # identity-resolver reads the GLOBAL dme_organization singleton
  # (.eq("singleton", true), no org_id) via the unscoped client — the
  # billing entity is platform-wide, not tenant-scoped. Its tenant data
  # (clearinghouse_credentials) IS read through getOrgScopedClient(orgId).
  # A reviewed global-table exception, like requireAdmin above.
  --glob '!**/lib/billing/identity-resolver.ts'
  # Platform outreach (super-admin broadcast) operates EXCLUSIVELY on
  # platform-GLOBAL tables — platform_contacts / platform_email_campaigns
  # / platform_email_recipients (migration 0394) have NO org_id and belong
  # to the platform operator, not any tenant. Every callsite is gated by
  # requirePlatformAdmin (the cross-tenant tier above requireAdmin), which
  # deliberately does NOT attach req.orgId. Like the dme_organization and
  # organizations directory reads, these go through the unscoped
  # service-role client by design; there is no tenant to scope to. Reviewed
  # global-table exceptions.
  --glob '!**/lib/platform-outreach/**'
  --glob '!**/routes/platform/outreach-contacts.ts'
  --glob '!**/routes/platform/outreach-campaigns.ts'
  --glob '!**/routes/platform/unsubscribe.ts'
  --glob '!**/worker/jobs/platform-email-tick.ts'
  # The demo-lead nurture drip and its one-click unsubscribe operate on
  # public.newsletter_subscribers — a single platform-GLOBAL marketing list
  # keyed by email alone, with NO org_id (migration 0354; see the design
  # note in routes/storefront/newsletter.ts). It is the platform's list, not
  # any tenant's, so there is no org to scope to — the same global-table
  # rationale as the platform-outreach entries above. The drip is a worker
  # tick (no req.orgId) and the unsubscribe route is public/anonymous.
  --glob '!**/worker/jobs/demo-drip.ts'
  --glob '!**/routes/storefront/newsletter-unsubscribe.ts'
  # The voice pending-session store (migration 0418) is a platform-GLOBAL,
  # short-lived cross-replica handoff table keyed by an opaque conversationId
  # with NO org_id — the orgId, when there is one, rides INSIDE the payload.
  # It is claimed by the raw HTTP-server WS-upgrade handler (which runs before
  # any Express middleware, so there is no req.orgId), and the diagnostic and
  # CareMetric Breathe platform-sales flows have no tenant at all. There is no
  # org to scope to; the unscoped service-role client is correct here — the
  # same global-table rationale as the entries above.
  --glob '!**/lib/voice/pending-sessions.ts'
)

# Match a CALL (open paren) so bare `import { getSupabaseServiceRoleClient }`
# lines don't count as offenders.
PATTERN='getSupabaseServiceRoleClient\('
SCAN_DIRS=(artifacts/ lib/)

# Offending files (one path per line, sorted, repo-relative).
# `rg -l` exits 0 (matches), 1 (no matches), or 2 (a real error: bad
# pattern, unreadable dir, …). Tolerate ONLY "no matches" (1); a genuine
# rg failure must NOT be silently treated as "zero offenders", which would
# make the guard pass while enforcing nothing (the failure mode the
# architecture checker documents). Capture rg's own exit code directly
# (no pipe to mask it) before sorting.
set +e
offenders_raw="$(rg -l "${EXCLUDES[@]}" "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null)"
rg_status=$?
set -e
if [[ "$rg_status" -gt 1 ]]; then
  echo "check-tenant-isolation: ripgrep exited $rg_status (expected 0 or 1)." >&2
  echo "  Refusing to pass — a real rg error can't be read as 'zero offenders'." >&2
  exit 2
fi
offenders="$(printf '%s\n' "$offenders_raw" | grep -E . | sort -u || true)"

if [[ -n "$offenders" ]]; then
  echo "TENANT ISOLATION VIOLATION: direct getSupabaseServiceRoleClient() call(s)." >&2
  echo "These request/worker paths must reach the DB through getOrgScopedClient(req.orgId)" >&2
  echo "(lib/resupply-db/src/org-scoped-client.ts), not the raw service-role client:" >&2
  while IFS= read -r offender; do
    [[ -n "$offender" ]] && printf '  %s\n' "$offender" >&2
  done <<<"$offenders"
  echo >&2
  echo "If this is a genuinely global/auth table read (not tenant data), add a reviewed" >&2
  echo "exemption to EXCLUDES in scripts/check-tenant-isolation.sh with a justifying comment." >&2
  exit 1
fi

echo "check-tenant-isolation: OK — no direct getSupabaseServiceRoleClient() callsites in application code."
exit 0
