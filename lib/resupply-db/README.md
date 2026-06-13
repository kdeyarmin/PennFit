# @workspace/resupply-db

Supabase service-role client plus pure types for the PennPaps resupply
system. Owns the shared Postgres access layer for patients, equipment,
supplies, orders, consents, suppression, outbound-message, conversation,
storefront, and admin-support tables. Patient fields are stored as plaintext
`text`/`jsonb`; column-level pgcrypto encryption was removed in migration
`0025_strip_phi_encryption.sql`. ADR 003's hand-authored migration contract
still applies.

## Public Surface

- `getSupabaseServiceRoleClient()` - the shared, lazily-initialized Supabase
  JS client. Every package that needs to read or write application data at
  runtime should go through it.
- `Database`, `Json` - generated PostgREST row shapes from
  `./supabase-types.ts`.
- Pure types and constants from `./types.ts` (`AdminRole`,
  `EmailTokenPurpose`, `CommunicationPreferences`, etc.).
- Patient projection helpers such as `patient_latest_message`.
- `getDbPool()` - direct `pg` pool. Used by migration tooling under
  `./scripts` and by a small number of legacy worker paths that still need
  pool-level access, such as
  `artifacts/resupply-api/src/worker/jobs/bulk-campaign-tick.ts`. New
  runtime code should prefer the Supabase client.

Drizzle has been fully retired: no `drizzle-orm`, `drizzle-kit`, or
`drizzle-zod` dependency is declared anywhere, and no runtime code imports
it. The architecture checker still forbids Drizzle imports in the pure domain
layer so the boundary does not drift back.

## Migrations

SQL migration files live in `./drizzle/`. The directory name is historical:
new migrations are hand-written SQL, not Drizzle output. The directory and
the on-DB `drizzle.resupply_migrations` table keep their Drizzle-era names so
existing production history stays compatible. See `./drizzle/README.md` and
the comments at the top of `scripts/migrate.mjs` before touching this area.

### Apply Path

`scripts/migrate.mjs` is the canonical apply script. It is invoked by
`scripts/post-merge.sh` locally and by `scripts/deploy-migrate.mjs` during
deploys when `RUN_DB_MIGRATIONS=true`.

The migrator:

- reads every `./drizzle/<NNNN>_*.sql` file;
- sorts by numeric prefix, with lexicographic filename order as the tie-break;
- computes a SHA256 hash of each file's bytes;
- records applied hashes in
  `drizzle.resupply_migrations(id, hash, created_at)`;
- treats a migration as pending when its hash is absent from that table.

`./drizzle/meta/_journal.json` is frozen. The migrator reads it only to
recover the original Drizzle-era `created_at` timestamp for historical files;
new migrations are not journaled.

This means existing migration files are load-bearing:

- Editing an already-applied migration changes its hash and can make it run
  again on production.
- Renaming or renumbering an existing migration changes fresh-database replay
  order even though production dedupes by content hash.
- Legacy duplicate prefixes are intentional historical state; do not "fix"
  them without a full replay-proven migration-order rewrite.

Add a new, higher-numbered, idempotent corrective migration instead of
editing, deleting, or renaming a migration that exists on `main`.

### Pre-Commit Guards

`scripts/git-hooks/pre-commit` (installed via `scripts/install-hooks.sh`)
selectively runs:

- `scripts/check-resupply-architecture.sh` - when any `lib/resupply-*` or
  `artifacts/resupply-*` file changes.
- `scripts/check-resupply-migration-prefix.sh` - when a new SQL file is added
  under `./drizzle/`.
- `scripts/check-resupply-migration-immutability.sh` - when an existing SQL
  migration changes.

The historical schema/migration co-change rule and
`check-drizzle-drift.sh` were retired when the Drizzle schema directory was
deleted. New migrations are hand-written SQL and reviewed manually.

## Migration Prefix Moratorium

Any added migration file must use a 4-digit prefix strictly higher than every
existing SQL migration file and unique within the directory. Do not reuse
legacy duplicate prefixes. See `./drizzle/README.md` and
`docs/migration-state-investigation-2026-05-08.md` for the incident history
and the eventual rewrite procedure.
