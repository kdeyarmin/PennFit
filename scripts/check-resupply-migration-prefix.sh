#!/usr/bin/env bash
#
# Resupply DB migration-prefix moratorium check.
#
# Background:
#   The lib/resupply-db/drizzle/ tree is mid-drift. There are 73 SQL
#   files but only 52 entries in meta/_journal.json (last journaled
#   tag: 0049_physician_fax_outreach_status_pending_idx), and six
#   prefixes are duplicated: 0016, 0017, 0049, 0050, 0052, 0065.
#   See lib/resupply-db/drizzle/README.md and
#   docs/migration-state-investigation-2026-05-08.md for the full
#   story and why a code-only fix is unsafe.
#
# Rule enforced here:
#   Any migration file ADDED under lib/resupply-db/drizzle/ must have
#   a 4-digit prefix STRICTLY GREATER THAN the moratorium threshold
#   (currently 0066). Adding a file with prefix <= 0066 either:
#     - reuses one of the six already-duplicated prefixes, or
#     - lands inside the unjournaled range 0049..0066 — meaning a
#       fresh `migrate.mjs` deploy from this tree would silently skip
#       it, compounding the existing drift.
#
#   Modifying an existing migration is already prohibited by ADR 003
#   and caught in review, so we only check additions (--diff-filter=A).
#
# Behavior mirrors check-resupply-migration-pair.sh:
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
# Bypass for genuine emergencies (e.g. the coordinated rewrite ticket
# itself):
#     SKIP_HOOKS=1 git commit ...
#         (or)
#     git commit --no-verify ...
# and document the reason in the commit body.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

# The threshold below which new migration prefixes are forbidden.
# Lifts (with the script being updated or removed) after the
# coordinated rewrite described in the README.
THRESHOLD=66

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

violations=()
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  base="${f##*/}"
  # Match exactly NNNN_<rest>.sql at the top of the drizzle dir.
  # Files inside meta/ or any other subdir don't match the pathspec
  # above, so we don't need to re-filter here, but we do need to
  # extract the 4-digit prefix robustly.
  if [[ "$base" =~ ^([0-9]{4})_.+\.sql$ ]]; then
    prefix="${BASH_REMATCH[1]}"
    # 10# forces base-10 interpretation so a leading zero (e.g. 0049)
    # isn't read as octal and silently fail on '8'/'9'.
    if (( 10#$prefix <= THRESHOLD )); then
      violations+=("$f")
    fi
  fi
done

if (( ${#violations[@]} > 0 )); then
  printf -v threshold_padded '%04d' "$THRESHOLD"
  cat >&2 <<EOF

==============================================================================
ERROR: new resupply migration uses a forbidden prefix.

This commit adds the following migration file(s) under
lib/resupply-db/drizzle/ with a 4-digit prefix <= ${threshold_padded}:

EOF
  for v in "${violations[@]}"; do
    printf '    %s\n' "$v" >&2
  done
  cat >&2 <<EOF

The lib/resupply-db/drizzle/ tree is currently mid-drift:
  - meta/_journal.json stops at 0049_physician_fax_outreach_status_pending_idx
    (52 entries) but 73 SQL files exist on disk.
  - Six prefixes are duplicated: 0016, 0017, 0049, 0050, 0052, 0065.
  - A fresh migrate.mjs deploy would silently skip every unjournaled file.

Adding any new migration with prefix <= ${threshold_padded} either reuses
a duplicate prefix or lands inside the unjournaled range, compounding
the drift. Use a prefix > ${threshold_padded} (i.e. >= $((THRESHOLD + 1))) instead.

Read lib/resupply-db/drizzle/README.md and
docs/migration-state-investigation-2026-05-08.md for the full
rationale and the coordinated rewrite procedure that will eventually
lift this moratorium.

If you genuinely need to bypass (e.g. you are landing the coordinated
rewrite itself), use:

    SKIP_HOOKS=1 git commit ...
        (or)
    git commit --no-verify ...

and document the reason in the commit body.
==============================================================================

EOF
  exit 1
fi

# Quiet on the happy path so the hook output stays scannable.
exit 0
