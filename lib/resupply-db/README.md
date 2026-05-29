# @workspace/resupply-db

Supabase service-role client + pure types for the CPAP resupply system.
Owns the patients, equipment, supplies, orders, consents, suppression,
audit, outbound-message, and conversation tables. Patient fields are
stored as plaintext `text`/`jsonb`; column-level pgcrypto encryption was
removed in migration `0025_strip_phi_encryption.sql`. ADR 003's
hand-authored migration contract still applies.

## Public surface

- `getSupabaseServiceRoleClient()` — the shared, lazily-initialized
  Supabase JS client. Every resupply package that needs to read or
  write Postgres at runtime goes through it. **This is the only
  production data path.**
- `Database`, `Json` — generated PostgREST row shapes from
  `./supabase-types.ts`.
- Pure types and constants from `./types.ts` (`AdminRole`,
  `EmailTokenPurpose`, `CommunicationPreferences`, etc.).
- The `patient_latest_message` projection helpers
  (Supabase-flavored).
- `getDbPool` — direct `pg` pool. Used by the migration tooling
  under `./scripts` and by a small number of legacy worker paths
  that have not yet been ported to PostgREST (e.g.
  `artifacts/resupply-api/src/worker/jobs/bulk-campaign-tick.ts`).
  Architecture Rule 7 in `scripts/check-resupply-architecture.sh`
  enforces that nothing outside `lib/resupply-db` opens its own
  `pg` connection — callers must go through `getDbPool()` from this
  package or, preferably, the Supabase client.

Drizzle has been fully retired: no `drizzle-orm`, `drizzle-kit`, or
`drizzle-zod` dependency is declared anywhere, and no runtime code
imports it. `scripts/check-resupply-architecture.sh` additionally
forbids `drizzle-orm` imports in `lib/resupply-domain` (Rule 2) so
the pure-domain layer can't quietly take a dependency on a vendor
SDK; the rest of the workspace is covered by the absence of the
package from the lockfile.

## Migrations

SQL migration files live in `./drizzle/`. The directory name is
**historical** — new migrations are hand-written SQL (no `drizzle-kit`
involved). The directory will be renamed in a separate operational
change; see `./drizzle/README.md` and the comments at the top of
`scripts/migrate.mjs` for why the on-DB schema name
(`drizzle.resupply_migrations`) is preserved.

### Apply path

`scripts/migrate.mjs` is the canonical apply script. It is invoked
by `scripts/post-merge.sh` at deploy time and reads
`./drizzle/meta/_journal.json` to know what to apply. The on-DB
history table is `drizzle.resupply_migrations(id, hash, created_at)`.

Gating at deploy time looks **only** at `MAX(created_at)` in the
history table: any journal entry whose `when` is strictly greater
than that value gets applied, anything else is silently skipped.
The migrator does not compare hashes or tags. That means:

- Renaming an already-applied migration on disk is invisible to the
  deploy migrator (the `when` is unchanged, so nothing re-runs), but
  it will break a fresh-DB build that has to apply the whole journal
  from zero.
- Bumping the `when` of an already-applied migration to a higher
  value causes the migrator to re-run that file against production,
  typically blowing up with `42P07 duplicate_object` from a repeated
  `CREATE TABLE`.

So the journal + SQL files must stay byte-identical to what
production has applied — that constraint is enforced by code review
and ADR 003, not by the migrator itself.

### Pre-commit guards

`scripts/git-hooks/pre-commit` (installed via
`scripts/install-hooks.sh`) selectively runs:

- `scripts/check-resupply-architecture.sh` — when any
  `lib/resupply-*` or `artifacts/resupply-*` file changes. Enforces
  the architecture rules summarized above and in
  `docs/resupply/ARCHITECTURE.md`.
- `scripts/check-resupply-migration-prefix.sh` — when a new SQL
  file is added under `./drizzle/`. Enforces the prefix moratorium
  (see below).

The historical schema/migration co-change rule and
`check-drizzle-drift.sh` were retired when the Drizzle schema
directory was deleted (there is no TS schema to diff against
anymore). New migrations are hand-written SQL and reviewed manually.

## Migration prefix moratorium

Because the journal and on-disk SQL files have temporarily diverged,
any _added_ migration file must use a 4-digit prefix strictly greater
than `0066`. See `./drizzle/README.md` and
`docs/migration-state-investigation-2026-05-08.md` for the full
investigation and the eventual rewrite procedure.
