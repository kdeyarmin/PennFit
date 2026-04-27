#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
