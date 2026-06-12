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
# The allowlist freezes the duplicates that already exist on main as
# of 2026-06-12. They cannot be renumbered: applied migrations are
# immutable (ADR 003 / check-resupply-migration-immutability.sh), and
# the migrator handles the existing pairs in lexicographic order with
# a warning. DO NOT add entries to this list — fix the new collision
# by renaming the not-yet-merged file to the next free prefix instead.
#
# Self-contained and side-effect free; exits 0 on a clean tree.

set -euo pipefail

# Frozen "prefix:count" pairs — duplicates already on main, 2026-06-12.
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
    files="$(git ls-files 'lib/resupply-db/drizzle/*.sql' | grep "/${prefix}_" | sed 's/^/        /')"
    violations+=("    prefix ${prefix}: ${count} files (allowed ${allowed})
${files}")
  fi
done < <(
  git ls-files 'lib/resupply-db/drizzle/*.sql' \
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
