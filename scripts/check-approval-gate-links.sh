#!/usr/bin/env bash
#
# Every approval gate must lead somewhere.
#
# WHY THIS IS A REPO-LEVEL CHECK AND NOT A UNIT TEST
# --------------------------------------------------
# The registry lives in the API package
# (artifacts/resupply-api/src/lib/approval-gates/registry.ts) and the
# routes it points at are JSX in the SPA
# (artifacts/cpap-fitter/src/pages/admin/console.tsx). Neither package
# can import the other, and there is no runtime behaviour to assert
# without booting the SPA router — but the failure is real and quiet: the
# "Needs a person" panel shows a number, an operator who is already
# behind clicks it, and lands on a 404.
#
# So: compare the two files as data. A gate whose href stops being a real
# page fails here rather than in front of that operator.
#
# The registry deliberately contains hrefs to LIST pages, not to
# individual records, so a static path comparison is the right shape —
# there are no parameters to resolve.
#
#   bash scripts/check-approval-gate-links.sh
#   bash scripts/check-approval-gate-links.sh --self-test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$REPO_ROOT/artifacts/resupply-api/src/lib/approval-gates/registry.ts"
# Every file that can register an /admin route.
ROUTE_FILES=(
  "$REPO_ROOT/artifacts/cpap-fitter/src/pages/admin/console.tsx"
  "$REPO_ROOT/artifacts/cpap-fitter/src/App.tsx"
)

if [[ "${1:-}" == "--self-test" ]]; then
  # The check must FAIL on a made-up href. Proving that here means a
  # green run is evidence rather than an artifact of a broken matcher.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf 'href: "/admin/this-page-does-not-exist",\n' > "$tmp/registry.ts"
  printf '<Route path="/admin/real-page" />\n' > "$tmp/routes.tsx"
  if REGISTRY="$tmp/registry.ts" ROUTE_FILES_OVERRIDE="$tmp/routes.tsx" \
     bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
    echo "check-approval-gate-links: SELF-TEST FAILED — a bogus href passed." >&2
    exit 1
  fi
  echo "check-approval-gate-links: self-test OK (a bogus href is rejected)."
  exit 0
fi

# Self-test hooks.
REGISTRY="${REGISTRY:-$REGISTRY}"
if [[ -n "${ROUTE_FILES_OVERRIDE:-}" ]]; then
  ROUTE_FILES=("$ROUTE_FILES_OVERRIDE")
fi

if [[ ! -f "$REGISTRY" ]]; then
  echo "check-approval-gate-links: registry not found at $REGISTRY" >&2
  exit 1
fi

# Collect every `path="/admin/..."` the SPA registers.
routes="$(grep -ho 'path="/admin[^"]*"' "${ROUTE_FILES[@]}" 2>/dev/null \
  | sed 's/^path="//; s/"$//' | sort -u || true)"

if [[ -z "$routes" ]]; then
  echo "check-approval-gate-links: found no /admin routes — the matcher is broken, not the app." >&2
  exit 1
fi

missing=0
while IFS= read -r href; do
  [[ -z "$href" ]] && continue
  if ! printf '%s\n' "$routes" | grep -qxF "$href"; then
    echo "check-approval-gate-links: approval gate href '$href' has no matching SPA route." >&2
    missing=$((missing + 1))
  fi
done < <(grep -o 'href: "/admin[^"]*"' "$REGISTRY" | sed 's/^href: "//; s/"$//' | sort -u)

if (( missing > 0 )); then
  cat >&2 <<'MSG'

The "Needs a person" panel shows a count for every gate. A gate whose
href is not a real page shows a number an operator cannot act on — they
click it and land on a 404, while they are already behind.

Fix the href in artifacts/resupply-api/src/lib/approval-gates/registry.ts,
or add the route in artifacts/cpap-fitter/src/pages/admin/console.tsx.
MSG
  exit 1
fi

echo "check-approval-gate-links: OK — every approval gate leads to a real page."
