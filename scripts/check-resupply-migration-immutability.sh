#!/usr/bin/env bash
#
# Resupply DB migration immutability check.
#
# Background:
#   lib/resupply-db/scripts/migrate.mjs dedups applied migrations by the
#   sha256 of each file's CONTENT (the migrations.resupply_migrations.hash
#   column), NOT by filename. So editing an already-shipped migration
#   changes its hash, and the deploy-time migrator treats the file as a
#   brand-new PENDING migration and RE-APPLIES it against production. If
#   the rewritten SQL is not perfectly idempotent, that re-apply errors
#   and gates the deploy (railway.json's preDeployCommand keeps the
#   previous release on a non-zero exit).
#
#   This is not hypothetical. On 2026-06-05 an in-place edit to
#   0212_compliance_rules.sql (adding DROP TRIGGER IF EXISTS for
#   idempotency) changed its content hash; the migrator re-ran the file,
#   and an already-present copy's bare CREATE TRIGGER collided
#   ("trigger \"trg_compliance_rules_set_updated_at\" ... already exists"),
#   failing every Railway release until the migration ledger was
#   reconciled by hand.
#
#   It happened a second way on 2026-08-21. Commit 8f2106d RENUMBERED two
#   mask migrations (0510/0511 -> 0511/0512) and, in the same move,
#   rewrote their header cross-references. A renumber is a rename, and a
#   rename plus a content edit is still a content edit: the hashes moved,
#   the migrator re-applied both files, and 0512's non-idempotent Amara
#   cascade gated every deploy on a duplicate key. This check did not
#   catch it — see "Why renames need explicit handling" below.
#
# Rule enforced here:
#   Every migration file under lib/resupply-db/migrations/ that exists on
#   the base ref must still exist, with BYTE-IDENTICAL content, after the
#   change. Concretely:
#
#     - Modifying a shipped migration in place            -> FAIL
#     - Deleting a shipped migration                      -> FAIL
#     - Renumbering it, content byte-identical            -> pass
#     - Renumbering it while editing content (8f2106d)    -> FAIL
#     - Adding a brand-new migration                      -> pass (not ours)
#
#   The pass case is exactly the one migrate.mjs's content-hash dedup
#   already makes safe: the file's sha256 is unchanged, so the ledger
#   still counts it as applied and it is NOT re-applied. Everything that
#   moves a hash is a re-apply against production and must be reviewed.
#
#   The correct way to change a shipped migration's EFFECT is still a
#   NEW, higher-numbered corrective migration written idempotently —
#   never an in-place edit.
#
#   This is the complement of check-resupply-migration-prefix.sh, which
#   guards ADDED files and explicitly leaves the modify/delete side to
#   "review" (see its header: "we only check additions"). This check
#   closes that gap mechanically. Prefix COLLISIONS created by a
#   renumber are caught tree-wide by
#   check-resupply-migration-prefix-tree.sh, not here.
#
# Why renames need explicit handling:
#   git's rename detection is ON by default (diff.renames, since git
#   2.9) and is NOT disabled by --name-only. A renumber therefore
#   surfaces as a single R entry (git reported 8f2106d's two files as
#   R099 and R098), and R is excluded by --diff-filter=MD — so the old
#   revision of this check saw an EMPTY change set and passed clean on
#   the exact commit that broke the deploy. We pass --no-renames so a
#   rename decomposes back into D(old path) + A(new path), then pair the
#   two by content ourselves.
#
# Escape hatch (rare — e.g. an emergency hotfix that genuinely must make
# an already-applied migration idempotent in place rather than add a new
# corrective migration):
#   Record the file's basename in
#       lib/resupply-db/migrations/.migration-edit-allowlist
#   in the SAME change, so the override is reviewed in the PR diff. Remove
#   the entry once the edit has shipped. (Pre-commit can also be skipped
#   with SKIP_HOOKS=1 / git commit --no-verify, but CI honors only the
#   allowlist — a hook bypass leaves no trace in the PR.)
#
# Behavior:
#   - Reads BASE_REF / DIFF_TARGET from the environment — the same
#     contract as check-resupply-migration-prefix.sh:
#       Pre-commit caller leaves both unset → defaults to the staged
#       index vs HEAD (BASE_REF=HEAD, DIFF_TARGET=--cached).
#       CI caller uses BASE_REF=FETCH_HEAD DIFF_TARGET= to compare the
#       working tree vs the PR base.
#   - Self-skips with exit 0 if BASE_REF doesn't resolve (validation-
#     environment misconfiguration, not a contributor mistake).
#   - Idempotent and side-effect free.
#   - --self-test runs the .test sibling.

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MIGRATIONS_GLOB='lib/resupply-db/migrations/*.sql'
ALLOWLIST_FILE='lib/resupply-db/migrations/.migration-edit-allowlist'

BASE_REF="${BASE_REF:-HEAD}"
DIFF_TARGET="${DIFF_TARGET---cached}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  printf 'WARNING: %s does not resolve; skipping resupply migration-immutability check.\n' \
    "$BASE_REF" >&2
  exit 0
fi

# One diff per status letter, always with rename detection OFF so a
# renumber decomposes into D(old) + A(new) and both sides are visible.
run_diff() {
  local args=(diff)
  if [[ -n "$DIFF_TARGET" ]]; then
    args+=("$DIFF_TARGET")
  fi
  args+=(--no-renames --name-only "--diff-filter=$1" "$BASE_REF" -- "$MIGRATIONS_GLOB")
  git "${args[@]}" 2>/dev/null || true
}

mapfile -t modified < <(run_diff M)
mapfile -t deleted < <(run_diff D)
mapfile -t added < <(run_diff A)

# Content identity is the git blob OID: two files share an OID iff their
# bytes are identical, which is precisely the equivalence migrate.mjs's
# sha256 dedup uses. (We don't need the sha256 itself — only "same or
# not" — and git has already hashed every blob for us.)
blob_oid_before() {
  git rev-parse --verify --quiet "${BASE_REF}:$1" 2>/dev/null || true
}

blob_oid_after() {
  local path="$1" oid=""
  # DIFF_TARGET non-empty means we compared the INDEX (--cached), so the
  # post-change bytes are the staged blob, not whatever is on disk.
  if [[ -n "$DIFF_TARGET" ]]; then
    oid="$(git rev-parse --verify --quiet ":$path" 2>/dev/null || true)"
  fi
  if [[ -z "$oid" && -f "$path" ]]; then
    oid="$(git hash-object -- "$path" 2>/dev/null || true)"
  fi
  printf '%s' "$oid"
}

# Strip the 4-digit prefix so `0511_mask_size_run_corrections.sql` and
# `0512_mask_size_run_corrections.sql` share a stem. Used only to make
# the failure message name the likely rename partner.
stem() {
  local base="${1##*/}"
  printf '%s' "${base#[0-9][0-9][0-9][0-9]_}"
}

# Index every added file by content, and by stem for diagnostics.
declare -A added_by_oid=()
declare -A added_by_stem=()
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  oid="$(blob_oid_after "$f")"
  [[ -n "$oid" ]] && added_by_oid["$oid"]="$f"
  added_by_stem["$(stem "$f")"]="$f"
done

# Load the allowlist into a set of basenames. Blank lines and `#`
# comments are ignored; leading/trailing whitespace is trimmed so an
# entry like `  0212_compliance_rules.sql  # reason` matches cleanly.
declare -A allow=()
if [[ -f "$ALLOWLIST_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"                        # strip trailing comment
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    line="${line%"${line##*[![:space:]]}"}"   # rtrim
    [[ -z "$line" ]] && continue
    allow["$line"]=1
  done < "$ALLOWLIST_FILE"
fi

note_allowlisted() {
  printf '[migration-immutability] NOTE: %s is allowlisted for in-place edit (%s).\n' \
    "$1" "$ALLOWLIST_FILE" >&2
}

violations=()   # "<path>\t<explanation>"

# --- modified in place ------------------------------------------------------
# Always a hash move: the path survives carrying different bytes, so the
# migrator sees a pending migration. No rename pairing can rescue this.
for f in "${modified[@]}"; do
  [[ -z "$f" ]] && continue
  if [[ -n "${allow[${f##*/}]:-}" ]]; then
    note_allowlisted "$f"
    continue
  fi
  violations+=("$f"$'\t'"edited in place — its content hash moves, so the migrator re-applies it")
done

# --- deleted (which is also the old half of every renumber) -----------------
for f in "${deleted[@]}"; do
  [[ -z "$f" ]] && continue
  oid="$(blob_oid_before "$f")"

  # Content-preserving renumber: the exact bytes were re-added under a
  # new name in this same change. The sha256 is unchanged, the ledger
  # still counts it applied, nothing is re-applied. This is safe.
  if [[ -n "$oid" && -n "${added_by_oid[$oid]:-}" ]]; then
    printf '[migration-immutability] NOTE: renumber %s -> %s (content identical; hash unchanged).\n' \
      "${f##*/}" "${added_by_oid[$oid]##*/}" >&2
    continue
  fi

  if [[ -n "${allow[${f##*/}]:-}" ]]; then
    note_allowlisted "$f"
    continue
  fi

  partner="${added_by_stem["$(stem "$f")"]:-}"
  if [[ -n "$partner" ]]; then
    violations+=("$f"$'\t'"renumbered to ${partner##*/} but its CONTENT ALSO CHANGED — a renumber must be byte-identical")
  else
    violations+=("$f"$'\t'"deleted — a shipped migration's content must survive somewhere")
  fi
done

if (( ${#violations[@]} > 0 )); then
  cat >&2 <<'EOF'

==============================================================================
ERROR: an already-shipped resupply migration changed content.

migrate.mjs dedups applied migrations by the sha256 of each file's
CONTENT, not its name. Anything that moves that hash — an in-place edit,
a deletion, or a renumber that also rewrites so much as a comment — makes
the deploy-time migrator treat the file as PENDING and re-apply it
against production. If the SQL is not perfectly idempotent the re-apply
fails and gates the deploy: that is what broke the 2026-06-05 Railway
releases (in-place edit to 0212_compliance_rules.sql) and again the
2026-08-21 releases (commit 8f2106d renumbered 0511/0512 while rewriting
their header cross-references).

Offending file(s):
EOF
  for v in "${violations[@]}"; do
    printf '    %s\n        %s\n' "${v%%$'\t'*}" "${v#*$'\t'}" >&2
  done
  cat >&2 <<EOF

Fix, depending on what you were doing:

  * Changing a shipped migration's effect — do NOT edit it. Add a NEW,
    higher-numbered corrective migration that brings the schema to the
    desired state idempotently (CREATE ... IF NOT EXISTS,
    DROP ... IF EXISTS, ADD COLUMN IF NOT EXISTS,
    INSERT ... ON CONFLICT DO NOTHING, guarded DO \$\$ ... \$\$ blocks).

  * Renumbering off a prefix collision — keep the bytes IDENTICAL. Move
    the file and change nothing inside it, not even a comment or a
    cross-reference to its own number. Update those references in a
    separate follow-up commit that touches no migration, or leave them:
    a stale number in a SQL comment is harmless, a moved hash is not.
    Verify with:

        git diff --no-renames "\${BASE_REF:-HEAD}" -- '${MIGRATIONS_GLOB}'

If you genuinely must edit in place (rare — e.g. an emergency hotfix that
makes an already-applied migration idempotent), add the file's basename
to:

    ${ALLOWLIST_FILE}

in this same change so the override is reviewed in the PR, then remove the
entry once it has shipped. Pre-commit only: SKIP_HOOKS=1 / --no-verify.
==============================================================================

EOF
  exit 1
fi

# Quiet on the happy path so the hook output stays scannable.
exit 0
