#!/usr/bin/env bash
#
# Resupply DB migration immutability check.
#
# Background:
#   lib/resupply-db/scripts/migrate.mjs dedups applied migrations by the
#   sha256 of each file's CONTENT (the drizzle.resupply_migrations.hash
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
# Rule enforced here:
#   A migration file under lib/resupply-db/drizzle/ that ALREADY EXISTS on
#   the base ref (i.e. is "shipped") must NOT be modified, deleted, or
#   renamed. The correct way to change a shipped migration's effect is a
#   NEW, higher-numbered corrective migration written idempotently — never
#   an in-place edit.
#
#   This is the complement of check-resupply-migration-prefix.sh, which
#   guards ADDED files and explicitly leaves the modify/delete side to
#   "review" (see its header: "we only check additions"). This check
#   closes that gap mechanically.
#
# Escape hatch (rare — e.g. an emergency hotfix that genuinely must make
# an already-applied migration idempotent in place rather than add a new
# corrective migration):
#   Record the file's basename in
#       lib/resupply-db/drizzle/.migration-edit-allowlist
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

MIGRATIONS_GLOB='lib/resupply-db/drizzle/*.sql'
ALLOWLIST_FILE='lib/resupply-db/drizzle/.migration-edit-allowlist'

BASE_REF="${BASE_REF:-HEAD}"
DIFF_TARGET="${DIFF_TARGET---cached}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  printf 'WARNING: %s does not resolve; skipping resupply migration-immutability check.\n' \
    "$BASE_REF" >&2
  exit 0
fi

# Modified (M) or deleted (D) shipped migrations. ADDED files are
# intentionally ignored here — the prefix check owns new migrations. A
# content-changing rename surfaces as D(old path)+A(new path) when rename
# detection is off (the default for --name-only), so the D arm still
# flags the vanished shipped file.
diff_args=(diff)
if [[ -n "$DIFF_TARGET" ]]; then
  diff_args+=("$DIFF_TARGET")
fi
diff_args+=(--name-only --diff-filter=MD "$BASE_REF" -- "$MIGRATIONS_GLOB")

mapfile -t changed < <(git "${diff_args[@]}" 2>/dev/null || true)

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

violations=()
for f in "${changed[@]}"; do
  [[ -z "$f" ]] && continue
  base="${f##*/}"
  if [[ -n "${allow[$base]:-}" ]]; then
    printf '[migration-immutability] NOTE: %s is allowlisted for in-place edit (%s).\n' \
      "$f" "$ALLOWLIST_FILE" >&2
    continue
  fi
  violations+=("$f")
done

if (( ${#violations[@]} > 0 )); then
  cat >&2 <<'EOF'

==============================================================================
ERROR: an already-shipped resupply migration was modified or deleted.

migrate.mjs dedups applied migrations by the sha256 of each file's
CONTENT, not its name. Editing (or deleting / renaming) a migration that
already exists on the base branch changes that hash, so the deploy-time
migrator treats it as PENDING and re-applies it against production. If the
rewritten SQL is not perfectly idempotent the re-apply fails and gates the
deploy — exactly what broke the 2026-06-05 Railway releases via an
in-place edit to 0212_compliance_rules.sql.

Offending file(s):
EOF
  for v in "${violations[@]}"; do
    printf '    %s\n' "$v" >&2
  done
  cat >&2 <<EOF

Fix: do NOT edit a shipped migration. Add a NEW, higher-numbered
corrective migration that brings the schema to the desired state
idempotently (CREATE ... IF NOT EXISTS, DROP ... IF EXISTS,
ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING, guarded
DO \$\$ ... \$\$ blocks).

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
