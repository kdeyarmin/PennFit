#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Resupply: ensure pgcrypto is enabled BEFORE pushing the resupply
# schema. The encrypted PHI columns rely on pgp_sym_encrypt /
# pgp_sym_decrypt at write/read time; the extension itself is
# orthogonal to Drizzle's schema diff and won't be added by `db push`.
node lib/resupply-db/scripts/preflight.mjs

pnpm --filter db push

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
