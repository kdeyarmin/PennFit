#!/usr/bin/env bash
#
# Resupply DB migration-prefix collision guard.
#
# Rule enforced here:
#   Any migration file ADDED under lib/resupply-db/drizzle/ must use a
#   4-digit prefix that is NOT already used by any other tracked file.
#   Duplicate prefixes cause migrate.mjs to emit warnings on every deploy and
#   make the prefix tie-break apply order harder to reason about on fresh
#   databases (ties are broken lexicographically by tag).
#
#   Modifying an existing migration is already prohibited by ADR 003
#   and caught in review, so we only check additions (--diff-filter=A).
#
# Behavior:
#   - Reads BASE_REF / DIFF_TARGET from the environment.
#       Pre-commit caller leaves both unset → defaults to staged
#       index vs HEAD (BASE_REF=HEAD, DIFF_TARGET=--cached).
#       CI caller can use BASE_REF=origin/main DIFF_TARGET= to compare
#       working tree vs origin/main.
#   - Self-skips with exit 0 if BASE_REF doesn't resolve (validation-
#     environment misconfiguration, not a contributor mistake).
#   - Idempotent and side-effect free.
#   - --self-test runs the .test sibling.
#
# Bypass for genuine emergencies:
#     SKIP_HOOKS=1 git commit ...
#         (or)
#     git commit --no-verify ...
# and document the reason in the commit body.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BASE_REF="${BASE_REF:-HEAD}"
DIFF_TARGET="${DIFF_TARGET---cached}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  printf 'WARNING: %s does not resolve; skipping resupply migration-prefix check.\n' \
    "$BASE_REF" >&2
  exit 0
fi

# Build the diff invocation. --diff-filter=A: added files only.
# Renamed-into is treated as added by git when the source content
# changed enough; that's the correct behavior here because a "new"
# prefix slot is what we care about regardless of provenance.
diff_args=(diff)
if [[ -n "$DIFF_TARGET" ]]; then
  diff_args+=("$DIFF_TARGET")
fi
diff_args+=(--name-only --diff-filter=A "$BASE_REF" -- 'lib/resupply-db/drizzle/*.sql')

mapfile -t added < <(git "${diff_args[@]}" 2>/dev/null || true)

collision_violations=()
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  base="${f##*/}"
  if [[ "$base" =~ ^([0-9]{4})_.+\.sql$ ]]; then
    prefix="${BASH_REMATCH[1]}"
    # Collision check: is the prefix already present in any tracked
    # migration filename? Scan tracked files directly and exclude paths
    # being added in this change so we do not count the new file(s)
    # themselves.
    count=0
    while IFS= read -r existing_file; do
      [[ -z "$existing_file" ]] && continue

      skip_added=0
      for af in "${added[@]}"; do
        if [[ "$existing_file" == "$af" ]]; then
          skip_added=1
          break
        fi
      done
      (( skip_added == 1 )) && continue

      existing_base="${existing_file##*/}"
      if [[ "$existing_base" =~ ^([0-9]{4})_.+\.sql$ ]] && [[ "${BASH_REMATCH[1]}" == "$prefix" ]]; then
        count=$((count + 1))
      fi
    done < <(git ls-files -- 'lib/resupply-db/drizzle/*.sql')
    if (( count > 0 )); then
      collision_violations+=("$f (prefix ${prefix} already exists)")
    fi
  fi
done

if (( ${#collision_violations[@]} > 0 )); then
  cat >&2 <<'EOF'

==============================================================================
ERROR: new resupply migration collides with an existing prefix.

This commit adds the following migration file(s) whose 4-digit
prefix is already used by another migration in
lib/resupply-db/drizzle/:

EOF
  for v in "${collision_violations[@]}"; do
    printf '    %s\n' "$v" >&2
  done
  cat >&2 <<'EOF'

When two migrations share a prefix, the migrate.mjs runner's apply
order becomes filesystem-dependent — and a fresh deploy may apply
one of the pair and silently skip the other. Pick the next free
prefix instead.
==============================================================================

EOF
  exit 1
fi

# Quiet on the happy path so the hook output stays scannable.
exit 0
