#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Apply checked-in versioned migrations (ADR 003). This replaces the
# prior `push:force` flow — `push` diffs the live DB and can silently
# rewrite columns once any data is present, which is not safe for
# either PHI tables or live storefront orders. The migrator is
# idempotent: already-applied migrations are skipped via the
# `drizzle.resupply_migrations` table.
#
# Task #37 (2026-05) deleted the separate `@workspace/db` package and
# folded the storefront tables under
# `@workspace/resupply-db/src/schema/storefront/`, so this single
# migrator now applies BOTH the resupply (`resupply.*`) and the
# storefront (`public.orders` etc.) migration histories in lockstep.
node lib/resupply-db/scripts/migrate.mjs

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
