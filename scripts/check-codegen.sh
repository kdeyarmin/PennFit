#!/usr/bin/env bash
# Detects drift between an OpenAPI spec and its committed generated
# client code.
#
# Why this exists:
#   `lib/resupply-api-spec/openapi.yaml` is the source of truth for the
#   resupply operator API; `lib/resupply-api-client/src/generated/` is
#   produced from it by orval. Penn Fit has the same arrangement
#   (`lib/api-spec/openapi.yaml` -> `lib/api-client-react/src/generated/`
#   AND `lib/api-zod/src/generated/`). The generated files are committed
#   so consumers don't need to run codegen at install time.
#
#   The risk: someone edits a spec and forgets to re-run codegen.
#   Typecheck still passes (the generated code hasn't changed, so its
#   shape is consistent with itself), but the dashboard then ships
#   calls that don't match the API. This script closes that gap by
#   running each pipeline's codegen during validation and asserting
#   the result matches what's committed.
#
# Strategy (per SPEC PACKAGE, not per output directory):
#   1. Snapshot ALL of that spec's output directories simultaneously,
#      BEFORE we run orval. (Doing this per-output-dir would be wrong
#      for Penn Fit, whose single orval invocation writes two output
#      dirs — the second snapshot would capture already-regenerated
#      bytes and the diff would always be empty.)
#   2. Run orval once for that spec.
#   3. Diff each output directory against its pre-regeneration
#      snapshot.
#   4. On ANY failure (drift detected OR orval itself errored),
#      restore every snapshotted directory atomically, then report
#      every drifted directory and exit non-zero with a message that
#      names the exact `pnpm` command to fix it.
#
# This applies the SAME drift check to both products so the convention
# stays consistent — "the spec is the source of truth, the generated
# directory is a build artifact that just happens to be committed."
#
# Usage:
#   bash scripts/check-codegen.sh
#       Check both pipelines (resupply + Penn Fit).
#
#   bash scripts/check-codegen.sh --self-test
#       Run the drift-detection self-test (see scripts/check-codegen.sh.test).

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Spec packages we check, in declaration order. For each spec we list
# the spec package id (for the user-facing fix command) and the
# directory to cd into to run orval.
SPECS=(
  "resupply|@workspace/resupply-api-spec|lib/resupply-api-spec"
  "penn-fit|@workspace/api-spec|lib/api-spec"
)

# Output directories produced by each spec, with a label for messages.
# Format: <spec-id>|<generated-dir>|<label>
OUTPUTS=(
  "resupply|lib/resupply-api-client/src/generated|Resupply API client"
  "penn-fit|lib/api-client-react/src/generated|Penn Fit API client (react-query)"
  "penn-fit|lib/api-zod/src/generated|Penn Fit API client (zod)"
)

outputs_for_spec() {
  local spec_id="$1"
  local row
  for row in "${OUTPUTS[@]}"; do
    if [[ "${row%%|*}" == "$spec_id" ]]; then
      printf '%s\n' "${row#*|}"   # "<dir>|<label>"
    fi
  done
}

# Per-spec check.
#
# All snapshots are taken BEFORE orval runs, so even when orval writes
# multiple output directories from a single invocation we always
# compare against the pre-regeneration state.
#
# On failure (drift OR orval error), every snapshot is restored before
# returning, so this script never leaves the working tree dirty.
check_spec() {
  local spec_id="$1"
  local spec_pkg="$2"
  local spec_dir="$3"

  local outputs=()
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    outputs+=("$row")
  done < <(outputs_for_spec "$spec_id")

  if [[ ${#outputs[@]} -eq 0 ]]; then
    printf 'ERROR: spec "%s" has no declared outputs\n' "$spec_id" >&2
    return 1
  fi

  # 1. Snapshot every output BEFORE doing anything.
  local snapshot_root
  snapshot_root="$(mktemp -d -t codegen-check.XXXXXX)"
  local i=0
  local labels=()
  local dirs=()
  for entry in "${outputs[@]}"; do
    IFS='|' read -r generated_dir label <<<"$entry"
    if [[ ! -d "$REPO_ROOT/$generated_dir" ]]; then
      printf 'ERROR: %s does not exist. Has the spec ever been generated?\n' \
        "$generated_dir" >&2
      rm -rf "$snapshot_root"
      return 1
    fi
    printf '  • %s\n' "$label"
    mkdir -p "$snapshot_root/$i"
    cp -a "$REPO_ROOT/$generated_dir/." "$snapshot_root/$i/"
    labels[$i]="$label"
    dirs[$i]="$generated_dir"
    i=$((i + 1))
  done

  # Helper that puts every snapshot back exactly as we found it.
  # Used both on drift and on orval failure so a developer running
  # this script never has to manually clean up after a failed run.
  restore_all() {
    local j=0
    while [[ $j -lt ${#dirs[@]} ]]; do
      rm -rf "$REPO_ROOT/${dirs[$j]}"
      mkdir -p "$REPO_ROOT/${dirs[$j]}"
      cp -a "$snapshot_root/$j/." "$REPO_ROOT/${dirs[$j]}/"
      j=$((j + 1))
    done
  }

  # 2. Run orval ONCE for this spec. We disable -e for just this call
  #    so we can react to its failure (rollback) instead of letting
  #    set -e exit before our cleanup runs. We invoke orval directly
  #    rather than the spec package's `codegen` script because that
  #    script tacks on a typecheck:libs step the validation gate
  #    already runs separately.
  set +e
  ( cd "$REPO_ROOT/$spec_dir" && pnpm exec orval --config ./orval.config.ts ) >/dev/null
  local orval_status=$?
  set -e

  if [[ $orval_status -ne 0 ]]; then
    restore_all
    rm -rf "$snapshot_root"
    cat >&2 <<EOF

==============================================================================
ERROR: orval failed for ${spec_pkg} (exit ${orval_status}).

This usually means the OpenAPI spec at ${spec_dir}/openapi.yaml has a
syntax or schema error that orval cannot process. Re-run the codegen
manually to see the full error message:

    pnpm --filter ${spec_pkg} run codegen

Generated files were rolled back to their committed state.

EOF
    return 1
  fi

  # 3. Diff each output against its pre-regeneration snapshot.
  local any_drift=0
  local drifted_labels=()
  local drift_diffs=()
  local k=0
  while [[ $k -lt ${#dirs[@]} ]]; do
    local diff_file="$snapshot_root/$k.diff"
    if ! diff -ruN "$snapshot_root/$k" "$REPO_ROOT/${dirs[$k]}" > "$diff_file"; then
      any_drift=1
      drifted_labels+=("${labels[$k]} (${dirs[$k]})")
      drift_diffs+=("$diff_file")
    fi
    k=$((k + 1))
  done

  if [[ $any_drift -eq 0 ]]; then
    rm -rf "$snapshot_root"
    return 0
  fi

  # 4. Drift detected. Restore everything and report every drift.
  restore_all
  cat >&2 <<EOF

==============================================================================
ERROR: codegen drift detected for ${spec_pkg}.

The committed files do not match what the OpenAPI spec at
${spec_dir}/openapi.yaml would produce. Most likely the spec was
edited without re-running codegen; less likely, the generated files
were edited by hand (don't — they will be overwritten next run).

Drifted output directories:
EOF
  for d in "${drifted_labels[@]}"; do
    printf '  - %s\n' "$d" >&2
  done
  cat >&2 <<EOF

To fix:

    pnpm --filter ${spec_pkg} run codegen
    git add lib
    git commit

Diff (first 200 lines per drifted dir, '<' = committed, '>' = regenerated):
EOF
  for diff_file in "${drift_diffs[@]}"; do
    printf '\n--- %s ---\n' "$diff_file" >&2
    head -n 200 "$diff_file" >&2
  done
  rm -rf "$snapshot_root"
  return 1
}

printf 'Checking OpenAPI codegen drift…\n'

failed=0
for entry in "${SPECS[@]}"; do
  IFS='|' read -r spec_id spec_pkg spec_dir <<<"$entry"
  if ! check_spec "$spec_id" "$spec_pkg" "$spec_dir"; then
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  printf '\nCodegen drift check FAILED. See messages above.\n' >&2
  exit 1
fi

printf '\nAll codegen pipelines are in sync with their specs.\n'
