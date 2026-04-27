#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Resupply: ensure pgcrypto is enabled BEFORE applying the resupply
# schema. The first migration also runs `CREATE EXTENSION IF NOT
# EXISTS pgcrypto`, but the preflight gives a clearer error if the
# connecting role lacks CREATE EXTENSION privilege (in which case a
# DBA needs to enable the extension manually before deploys can land).
node lib/resupply-db/scripts/preflight.mjs

# Resupply: apply checked-in versioned migrations (ADR 003). This
# replaces the prior `push:force` flow — `push` diffs the live DB and
# can silently rewrite columns once any data is present, which is not
# safe for PHI tables. The migrator is idempotent: already-applied
# migrations are skipped via the `drizzle.resupply_migrations` table.
node lib/resupply-db/scripts/migrate.mjs

pnpm --filter db push

# Install local git hooks so contributors get the resupply pre-commit
# checks (codegen drift + architecture rules) automatically after every
# merge, without any manual setup. Idempotent.
bash "$(dirname "$0")/install-hooks.sh"
