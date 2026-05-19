#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Apply checked-in versioned migrations (ADR 003). The migrator is
# idempotent: already-applied migrations are skipped via the
# `drizzle.resupply_migrations` table. (The history table name is
# historical — drizzle-kit was retired and migrations are now
# hand-written SQL applied by `lib/resupply-db/scripts/migrate.mjs`.)
#
# This single migrator applies BOTH the resupply (`resupply.*`) and
# the storefront (`public.orders` etc.) migration histories in
# lockstep, from `lib/resupply-db/drizzle/*.sql`.
node lib/resupply-db/scripts/migrate.mjs

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
