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
#   1. Make a temp workspace per output directory and tell orval —
#      via env vars its config respects — to write its output there
#      instead of the live source tree.
#   2. Run orval once for that spec.
#   3. Diff each temp output against the matching committed dir.
#   4. On ANY failure (drift detected OR orval errored), report every
#      drifted directory and exit non-zero with a message that names
#      the exact `pnpm` command to fix it.
#
#   The live source tree is NEVER mutated by this script. That matters
#   because Vite dev servers (resupply-dashboard, cpap-fitter) watch
#   those directories — if we briefly deleted/rewrote them with the
#   classic snapshot/regen/restore dance, Vite's pre-transform would
#   blow up and the previews would render blank until the dev server
#   was manually restarted. Generating into a temp dir avoids that
#   class of bug entirely.
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

# Output directories produced by each spec, with a label and the env
# var the spec's orval.config.ts honors to redirect that output's
# workspace root to a temp dir.
#
# Each output's orval config has been wired so that when the env var
# is set, `workspace` resolves to that path; with `target: "generated"`
# the regenerated files land at "$ENV_VAR/generated", mirroring the
# live tree's layout exactly.
#
# Format: <spec-id>|<live-generated-dir>|<label>|<workspace-env-var>
OUTPUTS=(
  "resupply|lib/resupply-api-client/src/generated|Resupply API client|CODEGEN_OUT_RESUPPLY_CLIENT"
  "penn-fit|lib/api-client-react/src/generated|Penn Fit API client (react-query)|CODEGEN_OUT_PENN_FIT_CLIENT"
  "penn-fit|lib/api-zod/src/generated|Penn Fit API client (zod)|CODEGEN_OUT_PENN_FIT_ZOD"
)

outputs_for_spec() {
  local spec_id="$1"
  local row
  for row in "${OUTPUTS[@]}"; do
    if [[ "${row%%|*}" == "$spec_id" ]]; then
      printf '%s\n' "${row#*|}"   # "<live-dir>|<label>|<env-var>"
    fi
  done
}

# Per-spec check.
#
# Orval is invoked ONCE per spec with all of that spec's workspace env
# vars set, so multi-output specs (Penn Fit) regenerate everything in
# a single pass — which matches how `pnpm run codegen` actually works
# and avoids any per-output ordering surprises.
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

  local temp_root
  temp_root="$(mktemp -d -t codegen-check.XXXXXX)"

  # Build per-output bookkeeping plus the env-var assignments we'll
  # pass to orval. Each output gets its own subdir of temp_root so
  # multiple outputs in the same spec can't clobber each other.
  local i=0
  local labels=()
  local live_dirs=()
  local regen_dirs=()
  local env_assigns=()
  local entry
  for entry in "${outputs[@]}"; do
    local live_dir label env_var
    IFS='|' read -r live_dir label env_var <<<"$entry"
    if [[ ! -d "$REPO_ROOT/$live_dir" ]]; then
      printf 'ERROR: %s does not exist. Has the spec ever been generated?\n' \
        "$live_dir" >&2
      rm -rf "$temp_root"
      return 1
    fi
    printf '  • %s\n' "$label"
    local temp_workspace="$temp_root/$i"
    mkdir -p "$temp_workspace"
    # If the live workspace ships a custom-fetch.ts (the mutator
    # implementation), copy it into the temp workspace so orval's
    # mutator path resolves to a real file AND its generated import
    # comes out as "../custom-fetch" (matching the committed copy).
    # Without this, orval would emit a long
    # "../../../../home/runner/workspace/lib/..." import and the
    # diff would always be non-empty for mutator-using outputs.
    # The live src dir is the parent of `generated/`.
    local live_src_parent="$REPO_ROOT/${live_dir%/generated}"
    if [[ -f "$live_src_parent/custom-fetch.ts" ]]; then
      cp -a "$live_src_parent/custom-fetch.ts" "$temp_workspace/custom-fetch.ts"
    fi
    env_assigns+=("$env_var=$temp_workspace")
    labels[$i]="$label"
    live_dirs[$i]="$live_dir"
    regen_dirs[$i]="$temp_workspace/generated"
    i=$((i + 1))
  done

  # Run orval ONCE for this spec, with workspace env vars set so its
  # output lands in temp dirs instead of the live source tree. We
  # disable -e for just this call so we can react to orval's failure
  # (cleanup) instead of letting set -e short-circuit our error
  # handling. We invoke orval directly rather than the spec package's
  # `codegen` script because that script tacks on a typecheck:libs
  # step the validation gate already runs separately.
  set +e
  ( cd "$REPO_ROOT/$spec_dir" \
      && env "${env_assigns[@]}" pnpm exec orval --config ./orval.config.ts ) >/dev/null
  local orval_status=$?
  set -e

  if [[ $orval_status -ne 0 ]]; then
    rm -rf "$temp_root"
    cat >&2 <<EOF

==============================================================================
ERROR: orval failed for ${spec_pkg} (exit ${orval_status}).

This usually means the OpenAPI spec at ${spec_dir}/openapi.yaml has a
syntax or schema error that orval cannot process. Re-run the codegen
manually to see the full error message:

    pnpm --filter ${spec_pkg} run codegen

The live generated files were not touched.

EOF
    return 1
  fi

  # Diff each regenerated output against its committed copy.
  local any_drift=0
  local drifted_labels=()
  local drift_diffs=()
  local k=0
  while [[ $k -lt ${#live_dirs[@]} ]]; do
    local diff_file="$temp_root/$k.diff"
    if [[ ! -d "${regen_dirs[$k]}" ]]; then
      printf 'ERROR: orval did not produce expected output at %s\n' \
        "${regen_dirs[$k]}" >&2
      rm -rf "$temp_root"
      return 1
    fi
    # `<` (left side of diff) is the committed copy on disk; `>` is
    # the freshly-regenerated copy. The user-facing message below
    # documents this orientation.
    if ! diff -ruN "$REPO_ROOT/${live_dirs[$k]}" "${regen_dirs[$k]}" > "$diff_file"; then
      any_drift=1
      drifted_labels+=("${labels[$k]} (${live_dirs[$k]})")
      drift_diffs+=("$diff_file")
    fi
    k=$((k + 1))
  done

  if [[ $any_drift -eq 0 ]]; then
    rm -rf "$temp_root"
    return 0
  fi

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

The live generated files were not touched by this check.

Diff (first 200 lines per drifted dir, '<' = committed, '>' = regenerated):
EOF
  for diff_file in "${drift_diffs[@]}"; do
    printf '\n--- %s ---\n' "$diff_file" >&2
    head -n 200 "$diff_file" >&2
  done
  rm -rf "$temp_root"
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
