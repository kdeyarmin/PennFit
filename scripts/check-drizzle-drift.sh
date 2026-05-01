#!/usr/bin/env bash
# Detects drift between a drizzle schema (TypeScript) and its committed
# migrations directory.
#
# Why this exists:
#   Both `lib/db/src/schema/*.ts` (storefront) and
#   `lib/resupply-db/src/schema/*.ts` (resupply) drive their respective
#   `drizzle/` migration histories via `drizzle-kit generate`. The
#   generated SQL + snapshot JSON is committed so deploys never have to
#   run codegen at install time. The risk: someone edits a schema file
#   and forgets to run `pnpm --filter @workspace/<lib> run generate`.
#   Typecheck still passes (the TS schema is internally consistent) and
#   the next deploy applies the OLD migrations, so the live DB silently
#   lags the TypeScript types until the next person runs `generate` and
#   gets a confusing "diff against where, exactly?" migration in code
#   review. This script closes that gap by running `drizzle-kit
#   generate` for each lib and asserting it produces no new files.
#
# Strategy (per drizzle lib):
#   1. Snapshot the committed `drizzle/` directory to a temp dir.
#   2. Run `drizzle-kit generate` against the live config. When the
#      schema and committed snapshots agree, drizzle prints "No schema
#      changes" and writes nothing. When they disagree it writes a new
#      `<NNNN>_<random>.sql` plus an updated snapshot.
#   3. Diff snapshot vs live `drizzle/` after the run.
#   4. ALWAYS restore the snapshot back over `drizzle/` before
#      returning, so a drifted run does NOT leave a stray new
#      migration file in the contributor's working tree (otherwise
#      every retry would produce a new randomly-named file).
#   5. On drift: report which lib drifted and the exact `pnpm` command
#      to fix it.
#
# Why this mirrors check-codegen.sh rather than using its workspace-env
# trick: drizzle-kit's `out` is fixed by the config file and has no env
# override. Snapshot/regen/diff/restore is the simplest robust pattern,
# and is safe here because nothing watches the `drizzle/` directories
# (unlike the api-client `generated/` dirs that Vite watches — which is
# why check-codegen.sh goes to such lengths to avoid touching them).
#
# Requires DATABASE_URL because both drizzle.config.ts files throw on
# import if it is unset. drizzle-kit generate itself does not connect
# to the DB — it only reads the TS schema and the committed snapshot —
# but the config import will short-circuit without it. If unset, the
# script exits 0 with a warning so it doesn't false-fail on a fresh
# checkout where the contributor hasn't provisioned a DB yet.
#
# Usage:
#   bash scripts/check-drizzle-drift.sh
#       Check both libs.
#
#   bash scripts/check-drizzle-drift.sh --self-test
#       Run the drift-detection self-test (see check-drizzle-drift.sh.test).

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  printf 'check-drizzle-drift: DATABASE_URL not set, skipping (drizzle.config.ts requires it on import)\n' >&2
  exit 0
fi

# Format: <pnpm-package-name>|<lib-dir>|<drizzle-out-dir>
#
# lib/resupply-db is intentionally NOT in this list yet: its snapshot
# meta (drizzle/meta/000N_snapshot.json) only covers 0000-0003 while
# 25+ migration SQL files have shipped — most were hand-authored per
# ADR 003 without updating the snapshot chain. drizzle-kit generate
# therefore short-circuits with a "snapshot collision" error before it
# can compute a diff, so we cannot detect drift there until someone
# rebuilds the snapshot chain. See follow-up task on this ticket. Once
# the snapshot chain is repaired, add:
#   "@workspace/resupply-db|lib/resupply-db|lib/resupply-db/drizzle"
LIBS=(
  "@workspace/db|lib/db|lib/db/drizzle"
)

restore_snapshot() {
  local snap="$1"
  local out_dir="$2"
  rm -rf "${REPO_ROOT:?}/$out_dir"
  mkdir -p "$REPO_ROOT/$out_dir"
  # cp -a preserves timestamps so the restored tree is byte-identical
  # to the snapshot (matters because some downstream tooling stats the
  # files and we don't want phantom "modified" detections).
  cp -a "$snap/." "$REPO_ROOT/$out_dir/"
}

check_lib() {
  local pkg="$1"
  local lib_dir="$2"
  local out_dir="$3"

  if [[ ! -d "$REPO_ROOT/$out_dir" ]]; then
    printf 'ERROR: %s does not exist. Has the schema ever been generated?\n' \
      "$out_dir" >&2
    return 1
  fi

  printf '  • %s\n' "$pkg"

  local snap
  snap="$(mktemp -d -t drizzle-drift.XXXXXX)"
  cp -a "$REPO_ROOT/$out_dir/." "$snap/"
  local generate_log="$snap.log"
  local diff_file="$snap.diff"

  # Signal-safe restoration: if the script is interrupted (Ctrl-C,
  # SIGTERM) between snapshot and the explicit restore on the normal
  # exit path, we still need the working tree to look exactly as it
  # did before this function ran. The trap restores the out_dir from
  # the snapshot and removes the temp paths, then re-raises the signal
  # so the parent shell sees the right exit status. The trap is
  # cleared at the bottom of the function so subsequent libs
  # (or other shell work) don't inherit it.
  # shellcheck disable=SC2064 # intentional: capture out_dir/snap NOW.
  trap "restore_snapshot '$snap' '$out_dir'; rm -rf '$snap' '$generate_log' '$diff_file'; trap - INT TERM EXIT; exit 130" INT TERM

  # Capture combined stdout+stderr so we can detect drizzle-kit's
  # known exit-0-on-error quirk: it prints an "Error: ..." line and
  # exits 0 when its snapshot meta chain is inconsistent. If we
  # trusted the exit code alone, a corrupted meta dir would silently
  # look like "no drift". Disable -e for the call so we can react to
  # a non-zero rc ourselves.
  set +e
  ( cd "$REPO_ROOT/$lib_dir" \
      && pnpm exec drizzle-kit generate --config ./drizzle.config.ts ) \
      > "$generate_log" 2>&1
  local rc=$?
  set -e

  # Treat both an explicit non-zero exit AND any case-insensitive
  # `Error:` line in the captured output as a tool failure. The
  # case-insensitive variant catches both `Error:` (drizzle-kit
  # today) and `error:` (some node tracebacks) without depending on
  # exact framing. We strip ANSI color codes first so a TTY-detected
  # \e[31mError:\e[0m on stderr still matches.
  if [[ $rc -ne 0 ]] \
      || sed -E 's/\x1B\[[0-9;]*[a-zA-Z]//g' "$generate_log" \
         | grep -qiE '^[[:space:]]*error:'; then
    restore_snapshot "$snap" "$out_dir"
    cat >&2 <<EOF

==============================================================================
ERROR: drizzle-kit generate failed for ${pkg} (exit ${rc}).

This usually means the TypeScript schema in ${lib_dir}/src/schema has
a syntax error, the config cannot be imported, or the snapshot meta
in ${out_dir}/meta is inconsistent with the committed migrations.
Re-run manually to see the full output:

    pnpm --filter ${pkg} run generate

drizzle-kit output:
EOF
    sed 's/^/    /' "$generate_log" >&2
    rm -rf "$snap" "$generate_log"
    trap - INT TERM
    return 1
  fi

  set +e
  diff -ruN "$snap" "$REPO_ROOT/$out_dir" > "$diff_file"
  local drift=$?
  set -e

  # ALWAYS restore — the regenerated tree may contain a fresh
  # randomly-named migration file we don't want sitting in the working
  # copy. This must happen whether we detected drift or not.
  restore_snapshot "$snap" "$out_dir"
  rm -f "$generate_log"
  # Per-lib trap done; unwire it before we exit the function so the
  # next iteration installs its own with the right snap/out_dir
  # captured.
  trap - INT TERM

  if [[ $drift -ne 0 ]]; then
    cat >&2 <<EOF

==============================================================================
ERROR: drizzle schema drift detected for ${pkg}.

The TypeScript schema in ${lib_dir}/src/schema does not match the
committed migrations in ${out_dir}. Most likely a contributor edited
the schema and forgot to regenerate; less likely, the migration
files were edited by hand (don't — they are derived from the schema).

To fix:

    pnpm --filter ${pkg} run generate

Then review the generated SQL — drizzle-kit's auto-generated
migrations are NOT always production-safe (column type changes that
require data backfill, destructive renames, etc.). Hand-edit the
migration if needed (per ADR 003), then:

    git add ${out_dir}
    git commit

The committed migration files were not modified by this check.

Diff (first 200 lines, '<' = committed snapshot, '>' = regenerated):
EOF
    head -n 200 "$diff_file" >&2
    rm -rf "$snap" "$diff_file"
    return 1
  fi

  rm -rf "$snap" "$diff_file"
  return 0
}

printf 'Checking drizzle schema drift…\n'

failed=0
for entry in "${LIBS[@]}"; do
  IFS='|' read -r pkg lib_dir out_dir <<<"$entry"
  if ! check_lib "$pkg" "$lib_dir" "$out_dir"; then
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  printf '\nDrizzle drift check FAILED. See messages above.\n' >&2
  exit 1
fi

printf '\nAll drizzle schemas are in sync with their committed migrations.\n'
