#!/usr/bin/env bash
#
# Raw-escape-hatch org-scope guard.
#
# THE INVARIANT
#   `check-tenant-isolation.sh` enforces that application code reaches the DB
#   through `getOrgScopedClient(orgId)` rather than the raw service-role
#   client. But that org-scoped client exposes a `.raw()` escape hatch (used
#   for cross-schema reads of `public.*` tables and `resupply.*` VIEWS that the
#   typed `.from()` facade doesn't know about). `.raw()` bypasses the automatic
#   org filtering, so any `.raw()` access to a TENANT-SCOPED table/view must
#   carry an explicit `org_id` filter — otherwise the query silently spans
#   every tenant.
#
#   Two real cross-tenant leaks shipped exactly this way (the PHI-bearing
#   `public.orders` admin reads, and the `fitter_campaign_touch_variant_metrics`
#   view) because the chokepoint guard only inspects `getOrgScopedClient(...)`
#   callsites, not the `.raw()` chains downstream. This guard closes that gap.
#
# WHAT IT CHECKS
#   For every `.from("<table>")` whose table is in GUARDED_TABLES below, the
#   call-chain statement (the `.from(...)` line forward to the statement
#   terminator) must contain a REAL org-scope OPERATION — not merely the
#   substring `org_id` (a selected column, comment, or string literal must NOT
#   satisfy a security gate). Accepted:
#     * a filter:  .eq("org_id", …) / .in("org_id", …) / .match({ org_id … })
#     * an insert/update stamp:  org_id:
#
#   The table list is a curated allowlist of tenant-scoped objects that are
#   reached via `.raw()`. Adding a new such table here is a deliberate,
#   reviewed step — the same posture as the EXCLUDES in
#   check-tenant-isolation.sh.
#
# EXEMPTION
#   A callsite with a genuinely non-org access pattern — a capability lookup
#   keyed by a bearer credential (e.g. a random reference + email), or a
#   platform-wide aggregation to the platform operator — declares itself with a
#   `raw-org-scope-exempt` marker comment (on or just above the `.from(...)`),
#   with a justification. This is the visible, reviewed escape hatch, mirroring
#   the EXCLUDES in check-tenant-isolation.sh — not a routine bypass.
#
# Usage:
#   bash scripts/check-raw-org-scope.sh            # enforce (CI)
#   bash scripts/check-raw-org-scope.sh --self-test
#
# Bypass (genuine emergencies): SKIP_HOOKS=1 / --no-verify, documented in the
# commit body.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

ROOT="${RAW_ORG_SCOPE_ROOT:-$REPO_ROOT}"
cd "$ROOT"

if ! command -v rg >/dev/null 2>&1; then
  echo "check-raw-org-scope: ripgrep (rg) not found on PATH." >&2
  echo "  The guard cannot run without it; install ripgrep." >&2
  exit 2
fi

# Tenant-scoped objects accessed through the `.raw()` escape hatch that MUST
# carry an inline org_id filter at EVERY callsite. Keep this list curated and
# limited to objects with no sanctioned non-org access path.
#
# NOTE — `public.reminder_subscriptions` (org_id mig 0378) is deliberately NOT
# listed: its public manage/unsubscribe path is keyed by the capability token
# `manage_token` (globally unique, so the link works regardless of host) and
# org-scopes only the email-lookup branch, in a separate statement. A blunt
# always-inline rule would false-positive on that legitimate token path.
GUARDED_TABLES=(
  "orders"                                  # public.orders (PHI; org_id mig 0463)
  "fitter_campaign_touch_metrics"           # resupply VIEW (mig 0382)
  "fitter_campaign_touch_variant_metrics"   # resupply VIEW (mig 0464)
)
#
# Deliberately NOT guarded: resupply.voice_calls. Its org_id went unwritten
# for the whole of its life (see lib/voice/voice-call-record.ts), which
# emptied /admin/voice/metrics and the channel-engagement analytics for
# every tenant — but that was a missing WRITE, which this guard does not
# check, and both READS were already correct. Unlike the three entries
# above, voice_calls is in the typed facade, so listing it here would flag
# those correct org-scoped reads and push contributors toward blanket
# exemption markers, which is how a guard stops meaning anything. The
# write is pinned by a test instead (voice-call-record.test.ts).

# The org_id filter must appear somewhere in the SAME statement as the
# `.from("<table>")`. We scan from the `.from` line forward to the statement
# terminator (the first line ending in `;`), capped at MAX_SCAN lines as a
# defensive bound for chains that span unusually far (or lack a `;` because
# they sit inside a Promise.all([...]) array element).
MAX_SCAN="${RAW_ORG_SCOPE_MAX_SCAN:-25}"

# How many lines ABOVE the `.from(...)` to scan for a `raw-org-scope-exempt`
# marker (the explanatory comment block typically sits just above the chain).
LEAD_SCAN="${RAW_ORG_SCOPE_LEAD_SCAN:-14}"

EXCLUDES=(
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!**/*.test.ts'
  --glob '!**/*.test.tsx'
  --glob '!**/*.spec.ts'
  --glob '!**/test-helpers/**'
)

SCAN_DIRS=(artifacts/ lib/)

# Build an alternation of the guarded table names for the rg pattern.
joined=""
for t in "${GUARDED_TABLES[@]}"; do
  joined+="${joined:+|}$t"
done
PATTERN="\.from\(\"($joined)\"\)"

# `rg --vimgrep` prints file:line:col:matchtext, one per match. Tolerate exit 1
# (no matches) but not a real rg error (>=2).
set +e
matches="$(rg --vimgrep "${EXCLUDES[@]}" "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null)"
rg_status=$?
set -e
if [[ "$rg_status" -gt 1 ]]; then
  echo "check-raw-org-scope: ripgrep exited $rg_status (expected 0 or 1)." >&2
  echo "  Refusing to pass — a real rg error can't be read as 'zero offenders'." >&2
  exit 2
fi

offenders=()
while IFS= read -r m; do
  [[ -z "$m" ]] && continue
  file="${m%%:*}"
  rest="${m#*:}"
  line="${rest%%:*}"
  # Capture the statement: from the `.from(...)` line forward to the first line
  # whose code ends in `;` (the statement terminator), capped at MAX_SCAN. Then
  # require a REAL org-scope operation within it — not just any mention of the
  # substring "org_id" (which a selected column, a comment, or a string literal
  # would satisfy, letting an unscoped cross-tenant read slip through a security
  # gate). Accepted forms:
  #   * a filter:  .eq("org_id", …) / .in("org_id", …) / .match({ org_id … })
  #   * an insert/update stamp:  org_id:
  #   * an explicit, justified exemption marker:  raw-org-scope-exempt
  end=$((line + MAX_SCAN))
  block="$(awk -v start="$line" -v stop="$end" '
    NR < start { next }
    { print }
    # End the statement at the first line whose trailing non-space char is ";".
    { stripped = $0; sub(/[ \t\r]+$/, "", stripped) }
    stripped ~ /;$/ { exit }
    NR >= stop { exit }
  ' "$file")"
  # An exemption marker can sit ABOVE the .from() (on the comment block that
  # explains why), so also scan a window of leading context for it. The block
  # below the .from() is short, so a generous lead window covers the typical
  # "explanatory comment then the query chain" layout.
  lead_start=$((line > LEAD_SCAN ? line - LEAD_SCAN : 1))
  lead="$(sed -n "${lead_start},${line}p" "$file")"
  if grep -qE 'raw-org-scope-exempt' <<<"$block$lead"; then
    continue
  fi
  if ! grep -qE '\.(eq|in|match)\(\s*\{?\s*"?org_id"?|org_id\s*:' <<<"$block"; then
    offenders+=("$file:$line")
  fi
done <<<"$matches"

if [[ "${#offenders[@]}" -gt 0 ]]; then
  echo "RAW ORG-SCOPE VIOLATION: .raw() access to a tenant-scoped object without an org_id filter." >&2
  echo "These callsites read/write a guarded table/view via the .raw() escape hatch but do not" >&2
  echo "filter (or stamp) org_id within the statement, so the query spans every tenant:" >&2
  for o in "${offenders[@]}"; do
    printf '  %s\n' "$o" >&2
  done
  echo >&2
  echo "Add .eq(\"org_id\", orgId) to the read (or org_id: orgId to the insert)." >&2
  echo "If the callsite genuinely has no org to scope to (a capability lookup by bearer" >&2
  echo "credential, or a platform-wide aggregation to the platform operator), add a" >&2
  echo "'raw-org-scope-exempt' marker comment with a justification on/above the .from()." >&2
  exit 1
fi

echo "check-raw-org-scope: OK — every .raw() access to a guarded table carries an org_id filter."
exit 0
