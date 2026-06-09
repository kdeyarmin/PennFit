#!/usr/bin/env bash
#
# Guard against NEW "read my own source and grep it" tests.
#
# Background:
#   ~98 existing *.test.ts files assert behavior by `readFileSync`-ing a
#   source module and string-matching its contents (e.g.
#   `const SRC = readFileSync(join(__dirname, "x.ts")); expect(SRC.split(
#   "foo").length)...`). These pass even when the runtime logic is wrong
#   and break on harmless refactors — false confidence. Converting all 98
#   is a large, separate effort; what we CAN do cheaply is stop the
#   pattern from spreading.
#
# Rule enforced here:
#   A test file ADDED in this change (--diff-filter=A) must not pair a
#   `readFileSync(...)` call with a source-path marker (__dirname /
#   import.meta / fileURLToPath / a ".ts"/".tsx"/".mts" literal) in the
#   same call. Existing offenders are untouched — this only fires on
#   newly-added files, so the ~98 legacy cases don't block anyone.
#
# Escape hatch:
#   A genuinely-justified source read (e.g. asserting a generated file's
#   header, or a structural invariant with no behavioral equivalent) can
#   opt out with a line containing `allow-source-read` (typically in a
#   comment explaining why).
#
# Behavior / env:
#   - BASE_REF / DIFF_TARGET mirror the other drift checks. Pre-commit
#     leaves both unset → staged index vs HEAD. CI uses
#     BASE_REF=FETCH_HEAD DIFF_TARGET= to compare the PR tip vs base.
#   - Self-skips (exit 0) if BASE_REF doesn't resolve.
#   - `--self-test` runs the inline fixture checks below.

set -euo pipefail

# Returns 0 (true) if the file at $1 is a source-grep test offender.
file_is_offender() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  # Opt-out wins.
  if grep -q 'allow-source-read' "$f"; then
    return 1
  fi
  # A readFileSync call whose argument references a source path.
  if grep -Eq 'readFileSync\([^)]*(__dirname|import\.meta|fileURLToPath|\.tsx?|\.mts)' "$f"; then
    return 0
  fi
  return 1
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Clean test: behavioral, no source read.
  cat >"$tmp/clean.test.ts" <<'EOF'
import { describe, it, expect } from "vitest";
import { add } from "./add";
describe("add", () => { it("adds", () => { expect(add(1, 2)).toBe(3); }); });
EOF
  # Offender: reads its own source and greps it.
  cat >"$tmp/bad.test.ts" <<'EOF'
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("./mod.ts", import.meta.url), "utf8");
expect(SRC.includes("doThing")).toBe(true);
EOF
  # Offender but opted out → must NOT be flagged.
  cat >"$tmp/optout.test.ts" <<'EOF'
// allow-source-read: asserts the generated banner is present
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("./gen.ts", import.meta.url), "utf8");
EOF

  fail=0
  if file_is_offender "$tmp/clean.test.ts"; then
    echo "self-test FAIL: clean file flagged as offender" >&2
    fail=1
  fi
  if ! file_is_offender "$tmp/bad.test.ts"; then
    echo "self-test FAIL: offender not detected" >&2
    fail=1
  fi
  if file_is_offender "$tmp/optout.test.ts"; then
    echo "self-test FAIL: allow-source-read opt-out was not honored" >&2
    fail=1
  fi
  if (( fail == 0 )); then
    echo "check-no-source-grep-tests self-test passed."
  fi
  exit "$fail"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BASE_REF="${BASE_REF:-HEAD}"
DIFF_TARGET="${DIFF_TARGET---cached}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  printf 'WARNING: %s does not resolve; skipping source-grep-test check.\n' \
    "$BASE_REF" >&2
  exit 0
fi

diff_args=(diff)
if [[ -n "$DIFF_TARGET" ]]; then
  diff_args+=("$DIFF_TARGET")
fi
diff_args+=(--name-only --diff-filter=A "$BASE_REF" -- '*.test.ts' '*.test.tsx')

mapfile -t added < <(git "${diff_args[@]}" 2>/dev/null || true)

violations=()
for f in "${added[@]}"; do
  [[ -z "$f" ]] && continue
  if file_is_offender "$f"; then
    violations+=("$f")
  fi
done

if (( ${#violations[@]} > 0 )); then
  cat >&2 <<'EOF'

==============================================================================
ERROR: new test(s) assert by reading + grepping source instead of behavior.

These newly-added test files pair a readFileSync(...) call with a
source-path marker (__dirname / import.meta / a .ts/.tsx/.mts path):

EOF
  for v in "${violations[@]}"; do
    printf '    %s\n' "$v" >&2
  done
  cat >&2 <<'EOF'

A test that reads its own source and string-matches it passes even when
the runtime logic is wrong, and breaks on harmless refactors. Assert
BEHAVIOR instead — call the function / mount the component / drive the
handler and check what it does.

If a source read is genuinely the right tool here (e.g. asserting a
generated file's header, or a structural invariant with no behavioral
equivalent), add a line containing `allow-source-read` with a short
reason and this check will skip the file.
==============================================================================

EOF
  exit 1
fi

exit 0
