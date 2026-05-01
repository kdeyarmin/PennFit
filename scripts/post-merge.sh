#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Resupply: apply checked-in versioned migrations (ADR 003). This
# replaces the prior `push:force` flow — `push` diffs the live DB and
# can silently rewrite columns once any data is present, which is not
# safe for PHI tables. The migrator is idempotent: already-applied
# migrations are skipped via the `drizzle.resupply_migrations` table.
node lib/resupply-db/scripts/migrate.mjs

# Storefront: apply checked-in versioned migrations (ADR 003). This
# replaces the prior `pnpm --filter db push` flow — `push` diffs the
# live DB and can silently rewrite columns once any data is present,
# which is no longer safe now that real customer order data lives in
# the storefront tables. The migrator is idempotent: already-applied
# migrations are skipped via the `drizzle.storefront_migrations` table.
node lib/db/scripts/migrate.mjs

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
