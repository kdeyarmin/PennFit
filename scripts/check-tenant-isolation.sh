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
# MODE — RATCHET (against a shrinking baseline)
#   ~250 API files still call `getSupabaseServiceRoleClient()` directly
#   because the per-domain `org_id` cutover (workstream C) is mid-flight,
#   so a flat "zero direct callsites" rule would be a red build for weeks.
#   Instead this guard works against a committed BASELINE of the files
#   known to still use the raw client
#   (scripts/tenant-isolation-baseline.txt):
#     * HARD FAIL on a NEW offending file not in the baseline — new
#       request/worker code must use getOrgScopedClient from the start.
#       This is the load-bearing protection.
#     * NON-FATAL NOTICE on a STALE baseline entry (a file already cut
#       over or deleted). It is only reported, with the `--update` hint,
#       and does NOT fail the build. Rationale: the cutover lands on
#       `main` continuously and independently of any open PR; a hard
#       stale-fail would turn every in-flight PR red the moment an
#       unrelated cutover merged. A stale entry never weakens isolation
#       (the file is already fixed), so pruning it is hygiene, not a gate.
#   The baseline only ever shrinks (via --update). When it reaches empty,
#   drop the baseline machinery and this becomes a plain "no direct
#   callsites" check — the Phase 0 workstream-E gate (plan PR 0.8).
#
# Usage:
#   bash scripts/check-tenant-isolation.sh            # ratchet check (CI)
#   bash scripts/check-tenant-isolation.sh --update   # regenerate baseline
#                                                     # (removal-only diff)
#   bash scripts/check-tenant-isolation.sh --self-test
#
# After migrating (or adding) a file in a cutover PR, run --update and
# commit the baseline diff alongside the code change.
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

BASELINE_FILE="${TENANT_BASELINE_FILE:-$ROOT/scripts/tenant-isolation-baseline.txt}"

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
)

# Match a CALL (open paren) so bare `import { getSupabaseServiceRoleClient }`
# lines don't count as offenders.
PATTERN='getSupabaseServiceRoleClient\('
SCAN_DIRS=(artifacts/ lib/)

# Current set of offending files (one path per line, sorted, repo-relative).
# `rg -l` exits 1 on zero matches; tolerate under set -e.
current_offenders="$(
  rg -l "${EXCLUDES[@]}" "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null | sort -u || true
)"

write_baseline() {
  {
    cat <<'HEADER'
# Tenant-isolation baseline — API files that still call
# getSupabaseServiceRoleClient() directly instead of getOrgScopedClient().
#
# Managed by scripts/check-tenant-isolation.sh (workstream E1). The
# Phase 0 cutover is COMPLETE — this list is empty, so the guard is now a
# plain "no direct getSupabaseServiceRoleClient() callsite" check: ANY
# offender hard-fails CI. `--update` is removal-only (it refuses to add a
# new caller back), so the empty state can't regress. New code must use
# getOrgScopedClient(orgId) from the start.
HEADER
    [[ -n "$current_offenders" ]] && printf '%s\n' "$current_offenders"
  } >"$BASELINE_FILE"
}

if [[ "${1:-}" == "--update" ]]; then
  # Once the cutover is COMPLETE (the committed baseline has reached empty),
  # --update is REMOVAL-ONLY: it must never add a new direct caller back
  # onto the baseline. Enforcing this — rather than relying on the "do not
  # add entries" convention — is what locks the cutover in: a new file that
  # reaches for the raw service-role client can't be laundered onto the
  # baseline to dodge the guard; it has to use getOrgScopedClient from the
  # start. While the baseline is still non-empty (mid-cutover) or absent
  # (first bootstrap), --update records offenders as before.
  prior_entries="$(grep -vE '^[[:space:]]*(#|$)' "$BASELINE_FILE" 2>/dev/null | sort -u || true)"
  prior_count="$(printf '%s\n' "$prior_entries" | grep -c . || true)"
  if [[ -f "$BASELINE_FILE" && "$prior_count" -eq 0 ]]; then
    additions="$(comm -23 \
      <(printf '%s\n' "$current_offenders" | grep -E . || true) \
      <(printf '%s\n' "$prior_entries" | grep -E . || true) || true)"
    if [[ -n "$additions" ]]; then
      echo "check-tenant-isolation: --update refused — the cutover is complete and the" >&2
      echo "  baseline is removal-only. Convert these to getOrgScopedClient(orgId)" >&2
      echo "  instead of baselining them:" >&2
      printf '    %s\n' $additions >&2
      exit 1
    fi
  fi
  write_baseline
  count="$(printf '%s' "$current_offenders" | grep -c . || true)"
  echo "check-tenant-isolation: baseline rewritten — $count file(s) on the raw client." >&2
  exit 0
fi

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "check-tenant-isolation: baseline file missing ($BASELINE_FILE)." >&2
  echo "  Generate it once with: bash scripts/check-tenant-isolation.sh --update" >&2
  exit 2
fi

# Baseline entries minus comments/blank lines.
baseline_entries="$(grep -vE '^[[:space:]]*(#|$)' "$BASELINE_FILE" | sort -u || true)"

# Set differences. Feed both sides through grep -E . so an empty input is a
# truly empty stream (comm misbehaves on a lone trailing blank line).
new_violations="$(comm -23 \
  <(printf '%s\n' "$current_offenders" | grep -E . || true) \
  <(printf '%s\n' "$baseline_entries" | grep -E . || true) || true)"
stale_baseline="$(comm -13 \
  <(printf '%s\n' "$current_offenders" | grep -E . || true) \
  <(printf '%s\n' "$baseline_entries" | grep -E . || true) || true)"

status=0

if [[ -n "$new_violations" ]]; then
  status=1
  echo "TENANT ISOLATION VIOLATION: new direct getSupabaseServiceRoleClient() call(s)." >&2
  echo "These request/worker paths must reach the DB through getOrgScopedClient(req.orgId)" >&2
  echo "(lib/resupply-db/src/org-scoped-client.ts), not the raw service-role client:" >&2
  printf '  %s\n' $new_violations >&2
  echo >&2
fi

if [[ -n "$stale_baseline" ]]; then
  # Non-fatal: a stale entry means the file was already cut over (or
  # deleted) — isolation is not weakened, so don't break the build over
  # it (see header). Report it so a future --update can prune the list.
  echo "check-tenant-isolation: NOTE — baseline entr(y/ies) already cut over;" >&2
  echo "prune with: bash scripts/check-tenant-isolation.sh --update" >&2
  printf '  %s\n' $stale_baseline >&2
  echo >&2
fi

remaining="$(printf '%s\n' "$baseline_entries" | grep -c . || true)"
if [[ "$status" -eq 0 ]]; then
  echo "check-tenant-isolation: OK — $remaining file(s) remain on the cutover baseline."
fi

exit "$status"
