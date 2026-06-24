#!/usr/bin/env bash
#
# Resupply DB migration-prefix TREE-WIDE duplicate check.
#
# Companion to check-resupply-migration-prefix.sh, which inspects only
# the files ADDED in a diff. That diff-based check has a known hole
# (documented in its own header, and re-flagged as P2-15 in
# docs/app-review-2026-06-10.md): when two separate PRs race main and
# each adds a DIFFERENT migration with the SAME fresh prefix, neither
# PR's diff collides against its own base — the duplicate appears only
# on main, after both merge. That is exactly how 0208, 0248, 0250,
# 0253, 0254, and 0257 landed as duplicates.
#
# This script closes the hole by checking the WHOLE tree: it fails if
#   * any prefix not in the grandfathered allowlist below is duplicated,
#   * or a grandfathered prefix has gained MORE files than its frozen
#     count.
# Run it on every PR and on every push to main (CI drift job); the
# post-merge main run is the one that catches the racing-PR case.
#
# The allowlist freezes the duplicate prefixes that already exist on main.
# They cannot be renumbered: applied migrations are
# immutable (ADR 003 / check-resupply-migration-immutability.sh), and
# the migrator handles the existing pairs in lexicographic order with
# a warning. DO NOT add entries to this list to silence a collision you
# can still PREVENT — fix it by renaming the not-yet-merged file to the
# next free prefix in the racing PR, before merge.
#
# The ONLY time an entry is added here is when the race was lost and BOTH
# colliding migrations have already merged to main: at that point both are
# shipped/immutable, so neither can be renumbered (a rename trips the
# immutability guard — it reads as deleting a shipped file). The pair is
# grandfathered instead, exactly like 0337/0338 before it, and is safe iff
# the colliding migrations are independent so their lexicographic apply
# order can't matter. 0370 is such a case: THREE PRs each branched when the
# max prefix was 0369 and all merged before the tree-wide check fired —
# #1053's 0370_inbound_fax_twilio_sid_nullable (ALTER inbound_faxes),
# #1056's 0370_platform_billing_payment_method (ALTER tenant_billing_subscriptions),
# and #1058's 0370_low_stock_alert_state_org_pk (ALTER low_stock_alert_state).
# All three touch disjoint tables, so any apply order is equivalent. 0396 is
# the same kind of already-lost race: one file corrects the platform-outreach
# updated_at triggers while the other adds voice_calls.answered_by; they touch
# unrelated tables, so either apply order is safe. 0474 is the same again:
# #1239's 0474_shop_orders_delivered_email_sent_at (ALTER shop_orders ADD
# COLUMN) and #1242's 0474_drop_wrong_capped_rental_modifier_seed (DELETE/
# UPDATE on payer_modifier_rules + claim_templates) touch unrelated tables —
# and #1239 had ALREADY renumbered 0471/0472 -> 0474/0475 to dodge an earlier
# collision before #1242 independently took 0474 too — so either apply order
# is safe.
#
# Self-contained and side-effect free; exits 0 on a clean tree.

set -euo pipefail

# Frozen "prefix:count" pairs — duplicates already shipped on main.
GRANDFATHERED="
0016:2
0017:2
0049:2
0050:2
0052:2
0090:2
0142:3
0143:3
0149:3
0150:2
0156:4
0157:3
0179:2
0181:2
0208:3
0248:2
0250:2
0253:3
0254:2
0257:2
0337:2
0338:2
0370:3
0396:2
0474:2
"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

allowed_count_for() {
  local prefix="$1"
  local entry
  for entry in $GRANDFATHERED; do
    if [[ "${entry%%:*}" == "$prefix" ]]; then
      printf '%s' "${entry##*:}"
      return 0
    fi
  done
  printf '1'
}

violations=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  count="${line%% *}"
  prefix="${line##* }"
  allowed="$(allowed_count_for "$prefix")"
  if (( count > allowed )); then
    files="$(git ls-files 'lib/resupply-db/migrations/*.sql' | grep "/${prefix}_" | sed 's/^/        /')"
    violations+=("    prefix ${prefix}: ${count} files (allowed ${allowed})
${files}")
  fi
done < <(
  git ls-files 'lib/resupply-db/migrations/*.sql' \
    | sed 's|.*/||' \
    | grep -E '^[0-9]{4}_' \
    | cut -c1-4 \
    | sort \
    | uniq -c \
    | awk '$1 > 1 { print $1, $2 }'
)

if (( ${#violations[@]} > 0 )); then
  cat >&2 <<'EOF'

==============================================================================
ERROR: duplicated resupply migration prefix(es) in the tree.

The following prefixes are shared by more migration files than the
grandfathered allowlist permits:

EOF
  for v in "${violations[@]}"; do
    printf '%s\n' "$v" >&2
  done
  cat >&2 <<'EOF'

When two migrations share a prefix, the migrate.mjs runner's apply
order becomes filesystem-dependent. This usually happens when two
PRs each took the same "next free" prefix and both merged — the
per-PR diff check cannot see that race; this tree-wide check exists
to catch it right after the second merge.

Fix: rename the most recently merged file(s) to the next free prefix
(they have not been applied anywhere yet if this fired on the merge
that introduced them). Do NOT extend the grandfathered allowlist —
it freezes only the historical duplicates that production has
already applied.
==============================================================================

EOF
  exit 1
fi

exit 0
