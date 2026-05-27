#!/usr/bin/env bash
#
# Audits admin mutation routes for permission gates.
#
# Background
# ----------
# The May 2026 deep review (PR #340) flagged that 48 of ~126 admin
# routes used a bare `requireAdmin` gate (every-admin-can-everything)
# rather than the finer-grained `requirePermission("...")` middleware
# that was introduced for shop-returns and rolled out to ~78 other
# routes. The original recommendation was a runtime startup assertion;
# that would have broken boot on the day it shipped because those 48
# routes are unchanged.
#
# This script is the lighter-weight alternative: it scans every admin
# route file at CI time and reports
#
#   - mutations gated by `requirePermission(...)` (good)
#   - mutations gated only by `requireAdmin` (acceptable, but please
#     migrate to a permission)
#   - mutations with NEITHER gate (a real bug — these are public)
#
# Exit codes
# ----------
# 0 — at least one of the two gates is on every mutation. The
#     "permission/admin/total" rollup is printed for tracking.
# 1 — at least one mutation has NEITHER gate. The offenders are
#     printed with file:line so a reviewer can fix or accept the
#     drift in the PR description.
#
# To bypass (genuine emergency): SKIP_HOOKS=1 git commit ...
#
# Self-test:
#   bash scripts/check-admin-route-gates.sh --self-test
#       Run the negative-test harness — see the .test sibling.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${RESUPPLY_GATE_CHECK_ROOT:-$REPO_ROOT}"
cd "$ROOT"

ADMIN_DIR="artifacts/resupply-api/src/routes/admin"
if [[ ! -d "$ADMIN_DIR" ]]; then
  echo "admin-route-gates: $ADMIN_DIR not present — nothing to scan" >&2
  exit 0
fi

# Look-ahead window after a `router.X(` opening line. The handler
# arrow function in this codebase typically starts within ~25 lines
# (the longest declared route at the time of writing is the bulk-
# campaign send route at ~22 lines of middleware + Zod schema; 30
# is generous). If a future contributor declares a route that spans
# more than 30 lines of middleware before the handler arrow, bump
# this number and let the test catch any regression.
LOOKAHEAD=30

PERM_COUNT=0
ADMIN_COUNT=0
UNGATED_COUNT=0

ADMIN_LIST=""
UNGATED_LIST=""

while IFS=$'\t' read -r file line content; do
  # Pull the LOOKAHEAD lines starting at `line` so we can inspect
  # the middleware chain. `sed -n "N,Mp"` reads only the slice we
  # need — avoids the `tail -n+N | head -K` shape that races
  # SIGPIPE under `set -o pipefail` when head closes the pipe to
  # tail before tail has emitted all available lines (resulted in
  # intermittent exit=141 even when no route was actually ungated).
  end_line=$((line + LOOKAHEAD - 1))
  chunk="$(sed -n "${line},${end_line}p" "$file" 2>/dev/null)"

  # Try to extract a "/admin/..." path argument from the chunk. If
  # the call uses a non-admin path (rare in this directory but
  # defensive), skip it. `grep -m 1` exits on first match WITHOUT
  # closing the pipe early — avoids the SIGPIPE race a `... | head`
  # pipeline trips under `set -o pipefail`.
  route_path="$(printf '%s\n' "$chunk" | grep -oE -m 1 '"/admin/[^"]*"' || true)"
  if [[ -z "$route_path" ]]; then
    continue
  fi

  verb="$(printf '%s' "$content" | sed -E 's/.*router\.(post|patch|delete|put).*/\1/')"

  if printf '%s\n' "$chunk" | grep -qE 'requirePermission[[:space:]]*\('; then
    PERM_COUNT=$((PERM_COUNT + 1))
    continue
  fi
  # `requireAdmin` is the looser "admin or agent" gate; `requireAdminOnly`
  # is the stricter "admin only" wrapper around it. Both are valid; we
  # treat them as equivalent for this audit. The same word-boundary
  # match catches future `requireAdminXxx` variants — that's intentional
  # because they all start with the auth check.
  if printf '%s\n' "$chunk" | grep -qE '\brequireAdmin(Only)?\b'; then
    ADMIN_COUNT=$((ADMIN_COUNT + 1))
    ADMIN_LIST+="  $file:$line  $verb  $route_path"$'\n'
    continue
  fi
  UNGATED_COUNT=$((UNGATED_COUNT + 1))
  UNGATED_LIST+="  $file:$line  $verb  $route_path"$'\n'
done < <(
  grep -rEn 'router\.(post|patch|delete|put)[[:space:]]*\(' "$ADMIN_DIR" \
    --include="*.ts" 2>/dev/null \
    | grep -v "\.test\." \
    | sed -E 's/^([^:]+):([0-9]+):(.*)$/\1\t\2\t\3/'
)

TOTAL=$((PERM_COUNT + ADMIN_COUNT + UNGATED_COUNT))
{
  echo "admin-route-gates summary:"
  echo "  total mutations scanned: $TOTAL"
  echo "  with requirePermission:  $PERM_COUNT"
  echo "  with requireAdmin only:  $ADMIN_COUNT"
  echo "  ungated:                 $UNGATED_COUNT"
} >&2

if [[ $ADMIN_COUNT -gt 0 ]]; then
  {
    echo
    echo "admin-only (consider migrating to requirePermission):"
    printf '%s' "$ADMIN_LIST"
  } >&2
fi

if [[ $UNGATED_COUNT -gt 0 ]]; then
  {
    echo
    echo "UNGATED admin mutations (FIX REQUIRED — these routes are PUBLIC):"
    printf '%s' "$UNGATED_LIST"
  } >&2
  exit 1
fi

exit 0
