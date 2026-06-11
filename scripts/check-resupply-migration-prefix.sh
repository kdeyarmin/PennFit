#!/usr/bin/env bash
#
# Resupply DB migration-prefix moratorium check.
#
# Background:
#   The lib/resupply-db/drizzle/ tree is mid-drift. The original
#   moratorium documented six duplicated prefixes in the journaled
#   range — 0016, 0017, 0049, 0050, 0052, 0065 — and forbade any new
#   migration with prefix <= 0066. Since then, six MORE prefixes have
#   collided in the higher range — 0142 (3 files), 0143 (3), 0149 (3),
#   0150 (2), 0156 (4), 0157 (2). Each of those landed as a clean
#   single-file PR that didn't conflict on its own; the collision
#   appeared at MERGE time, after a sibling PR already used the same
#   prefix. The collision-detection branch below catches that case
#   for any new commit (including merge-conflict resolutions) — but
#   for fully separate PRs racing main, the check only fires when the
#   loser rebases. A CI job that fails on any duplicated prefix in
#   the tree (not just adds) would close that remaining hole; tracked
#   as a follow-up so this script can stay drop-in.
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

# Build the set of prefixes that ALREADY exist in the tree (excluding
# the files being added in THIS diff). A new migration must pick a
# prefix not already present, or it collides with another migration
# and the runner's apply order becomes filesystem-dependent. The
# 0142 / 0143 / 0149 pairs found during the May 2026 audit slipped
# past the moratorium threshold below precisely because there was no
# such collision check.
existing_prefixes=""
while IFS= read -r f; do
  base="${f##*/}"
  if [[ "$base" =~ ^([0-9]{4})_.+\.sql$ ]]; then
    existing_prefixes+=" ${BASH_REMATCH[1]}"
  fi
done < <(git ls-files 'lib/resupply-db/drizzle/*.sql' 2>/dev/null || true)

# Remove the just-added files from the existing set — they're part
# of the diff being checked, not pre-existing collisions. The
# `git diff` above already filters to --diff-filter=A.
added_basenames=""
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  added_basenames+=" ${f##*/}"
done

violations=()
collision_violations=()
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  base="${f##*/}"
  if [[ "$base" =~ ^([0-9]{4})_.+\.sql$ ]]; then
    prefix="${BASH_REMATCH[1]}"
    # 10# forces base-10 interpretation so a leading zero (e.g. 0049)
    # isn't read as octal and silently fail on '8'/'9'.
    if (( 10#$prefix <= THRESHOLD )); then
      violations+=("$f")
      continue
    fi
    # Collision check: is the prefix already present in any tracked
    # migration filename? Scan tracked files directly and exclude paths
    # being added in this change so we do not count the new file(s)
    # themselves.
    count=0
    while IFS= read -r existing_file; do
      [[ -z "$existing_file" ]] && continue

      # Skip only the file currently being checked (self) so that two new files
      # added in the same commit with the same prefix are caught.
      [[ "$existing_file" == "$f" ]] && continue

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
