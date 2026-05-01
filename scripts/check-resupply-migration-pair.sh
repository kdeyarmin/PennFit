#!/usr/bin/env bash
#
# Resupply DB co-change check.
#
# Catches the same class of bug as scripts/check-drizzle-drift.sh
# ("developer edited a Drizzle schema TS file but forgot to ship a
# matching migration") for the @workspace/resupply-db package, where
# the structural drift checker can't run because the journal /
# snapshot chain in lib/resupply-db/drizzle/meta is incomplete (the
# journal lists migrations 0000..0025 but only 0000..0003 have
# corresponding *_snapshot.json files, so drizzle-kit short-circuits
# with a "snapshot collision" error before computing a diff). See
# scripts/check-drizzle-drift.sh and the lib/resupply-db README for
# the full deferral rationale.
#
# Until the snapshot chain is repaired, this script enforces a
# weaker but useful invariant on every commit:
#
#   IF this commit modifies any file under lib/resupply-db/src/schema/
#   THEN this same commit MUST also add at least one new migration
#        SQL file under lib/resupply-db/drizzle/.
#
# That co-change rule does not catch every form of drift a structural
# checker would (e.g. an edit to schema TS plus an unrelated migration
# could still slip through), but it does reliably catch the dominant
# failure mode — "I changed a column type, ran nothing else, and
# committed" — which is the same class the storefront drift checker
# protects against.
#
# Behavior:
#   - Reads BASE_REF from the environment when set (for CI / validation
#     runs comparing against a merge base). Defaults to comparing the
#     staged index against HEAD, matching how the pre-commit hook
#     invokes the script.
#   - Self-skips with a 0 exit if BASE_REF is set but does not exist —
#     that's a validation-environment misconfiguration, not a
#     contributor mistake, and we don't want to block on it. A warning
#     goes to stderr.
#   - Idempotent and side-effect free.
#   - --self-test runs the .test sibling script, mirroring the
#     drift-check companion's interface.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Resolve the diff range. Pre-commit caller leaves both unset so we
# default to comparing the staged index against HEAD. A validation /
# CI caller can override:
#   - BASE_REF=origin/main DIFF_TARGET=    → working tree vs origin/main
#   - BASE_REF=origin/main DIFF_TARGET=    on a freshly-checked-out
#     CI tree compares the merge result against the base branch.
# The `${VAR-default}` form (single dash, no colon) only substitutes
# when the variable is *unset*, so an explicit empty string from the
# caller is honored as "no diff target flag" — `git diff $BASE_REF`
# without --cached compares working tree to BASE_REF.
BASE_REF="${BASE_REF:-HEAD}"
DIFF_TARGET="${DIFF_TARGET---cached}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  printf 'WARNING: %s does not resolve; skipping resupply migration-pair check.\n' \
    "$BASE_REF" >&2
  exit 0
fi

# Build the git diff invocation. When DIFF_TARGET is the empty
# string the caller wants "working tree vs BASE_REF", so we drop the
# positional flag entirely (passing "" would be parsed as a literal
# ref name and fail). Otherwise pass --cached / --staged / whatever
# the caller set.
diff_args=(diff)
if [[ -n "$DIFF_TARGET" ]]; then
  diff_args+=("$DIFF_TARGET")
fi
diff_args+=(--name-only --diff-filter=AMR "$BASE_REF")

# Names of files added/modified/renamed in the diff window. We only
# look at A/M/R; deletions don't trigger schema-vs-migration
# obligations on their own. (A delete-only schema change still drops
# the underlying table, but that is itself a migration-shaped change
# and would land alongside a migration in any reasonable workflow.)
mapfile -t changed < <(git "${diff_args[@]}" 2>/dev/null || true)

# A second pass with --diff-filter=A returns just the new files; used
# below to confirm a migration was *added* (not merely modified).
added_args=(diff)
if [[ -n "$DIFF_TARGET" ]]; then
  added_args+=("$DIFF_TARGET")
fi
added_args+=(--name-only --diff-filter=A "$BASE_REF")
added_files="$(git "${added_args[@]}" 2>/dev/null || true)"

schema_changed=0
new_migration=0
for f in "${changed[@]}"; do
  case "$f" in
    lib/resupply-db/src/schema/*|lib/resupply-db/src/schema/*/*)
      schema_changed=1
      ;;
    # New migration SQL must be ADDED (not just modified) to count
    # as "this commit shipped a migration." Modifying a previously-
    # committed migration is, per ADR 003, prohibited anyway and
    # would be caught by review. We check membership in the
    # precomputed added-only file list.
    lib/resupply-db/drizzle/[0-9]*.sql)
      if grep -Fxq "$f" <<<"$added_files"; then
        new_migration=1
      fi
      ;;
  esac
done

if [[ $schema_changed -eq 1 && $new_migration -eq 0 ]]; then
  cat >&2 <<EOF

==============================================================================
ERROR: resupply schema changed without a matching migration.

This commit modifies one or more files under lib/resupply-db/src/schema/
but does not add a new migration SQL file under lib/resupply-db/drizzle/.

The resupply database does not yet have automated structural drift
detection (snapshot chain repair is tracked separately), so we rely
on a co-change rule: every schema TS edit must ship with a hand-
authored migration file in the same commit. See ADR 003 for why
hand-authored — never \`db:push --force\`.

If you genuinely intended to ship a schema change, add the migration:

    # 1. Hand-author lib/resupply-db/drizzle/<NNNN>_<name>.sql
    # 2. Append a matching entry to lib/resupply-db/drizzle/meta/_journal.json
    # 3. Re-stage both files

If the schema edit was incidental (renaming a comment, adding a
JSDoc, etc.) and truly requires no migration, bypass this hook with:

    SKIP_HOOKS=1 git commit ...
        (or)
    git commit --no-verify ...

and leave a comment in the commit body explaining why.
==============================================================================

EOF
  exit 1
fi

# Quiet on the happy path so the hook output stays scannable.
exit 0
