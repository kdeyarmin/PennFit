#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Apply checked-in versioned migrations (ADR 003). The migrator is
# idempotent: already-applied migrations are skipped via the
# `migrations.resupply_migrations` table. (The history table name is
# historical — the ORM migration tooling was retired and migrations are now
# hand-written SQL applied by `lib/resupply-db/scripts/migrate.mjs`.)
#
# This single migrator applies BOTH the resupply (`resupply.*`) and
# the storefront (`public.orders` etc.) migration histories in
# lockstep, from `lib/resupply-db/migrations/*.sql`.
node lib/resupply-db/scripts/migrate.mjs

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
