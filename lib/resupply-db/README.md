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
- `getDbPool` — retained only for the migration tooling under
  `./scripts`. No production runtime path calls it.

Drizzle has been fully retired: no `drizzle-orm`, `drizzle-kit`, or
`drizzle-zod` dependency is declared anywhere, and no runtime code
imports it. Rule 7 in `scripts/check-resupply-architecture.sh`
enforces the "no direct `pg` outside `lib/resupply-db`" invariant,
and a separate rule forbids `drizzle-orm` imports in non-db packages.

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
`./drizzle/meta/_journal.json` to know what to apply.

The journal + SQL files MUST stay byte-identical to what production
has applied — renaming or re-tagging would cause the migrator to
reject the deploy or attempt to re-apply already-applied migrations.

### Schema-drift guard

`scripts/check-resupply-migration-pair.sh` is a co-change rule run
from the pre-commit hook: any commit that modifies a schema-shaping
file must also add a new migration SQL file under `./drizzle/`. It is
exercised by `scripts/check-resupply-migration-pair.sh.test`.

The historical `scripts/check-drizzle-drift.sh` structural check was
removed when the Drizzle tooling was retired — there is no longer a
TS schema to diff a snapshot against. The co-change rule above is
the remaining guard.

## Migration prefix moratorium

Because the journal and on-disk SQL files have temporarily diverged,
any *added* migration file must use a 4-digit prefix strictly greater
than `0066`. See `./drizzle/README.md` and
`docs/migration-state-investigation-2026-05-08.md` for the full
investigation and the eventual rewrite procedure.
