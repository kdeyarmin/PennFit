# Migration State Investigation — 2026-05-08

**Scope:** P0.1 (Drizzle journal drift) and P0.2 (six duplicate migration
prefixes) from `docs/codebase-enhancements-2026-05-08.md`.

**Status:** **DO NOT renaming files or rebuilding the journal in a code-only
PR.** The drift is much more than cosmetic; this needs a coordinated
operation with production-state visibility.

---

## What the input claim looked like

The triage doc claimed:

- P0.1: 52 journal entries vs 73 SQL files (drift of 21).
- P0.2: six duplicate migration prefixes (0016, 0017, 0049, 0050, 0052, 0065).
- Suggested fix: rename newer-of-each-pair, then `pnpm --filter
@workspace/resupply-db run generate` to rebuild the snapshot.

That framing assumed the unjournaled files were just "files that haven't
been told to drizzle yet" — i.e. lint, not data integrity.

## What actually happens at deploy time

`scripts/post-merge.sh:18` runs `node lib/resupply-db/scripts/migrate.mjs`
with **no preceding `drizzle-kit generate` step**. `migrate.mjs` calls
`drizzle-orm/migrator`'s `migrate()` against the on-disk
`lib/resupply-db/drizzle/` directory, which **only reads files referenced
by `meta/_journal.json`** — files in the directory but not journaled are
invisible to it.

So today:

- `_journal.json` has 52 entries (idx 0–51, last tag
  `0049_physician_fax_outreach_status_pending_idx`).
- Twenty-one SQL files (`0049_patient_documents.sql`, all of
  `0050_*` through `0066_*`) are **not journaled**.
- A fresh `migrate.mjs` run applies exactly 52 migrations; the schema
  ends at the 0049-pending-idx state.

I verified this against a fresh local Postgres (postgres:14, role
`pennfit` superuser):

```
$ PGPASSWORD=pennfit psql -h localhost -U pennfit -d pennfit_test -tA -c \
    "SELECT count(*) FROM drizzle.resupply_migrations"
52

$ PGPASSWORD=pennfit psql -h localhost -U pennfit -d pennfit_test -tA -c \
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns
     WHERE table_schema='resupply' AND table_name='shop_customers'
     AND column_name='facial_measurements')"
f

$ PGPASSWORD=pennfit psql -h localhost -U pennfit -d pennfit_test -tA -c \
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables
     WHERE table_schema='resupply' AND table_name='patient_therapy_links')"
f
```

`shop_customers.facial_measurements` (added by 0066) and the
`patient_therapy_links` table (added by 0064) are **absent** after a
clean `migrate.mjs` run.

## Why this matters

The TypeScript schema in `lib/resupply-db/src/schema/*.ts` _does_
reference these tables and columns, and the API code uses them. A
deploy that runs `migrate.mjs` against an empty DB and then boots the
API would fail at first query of `shop_customers.facialMeasurements`,
`patientTherapyLinks`, etc.

So one of the following must be true on production:

1. **A different migration mechanism is in use** — e.g. a CI step does
   `pnpm --filter @workspace/resupply-db run generate` first (which would
   regenerate the journal from the schema TS, picking up 0050+), or
   `drizzle-kit push` is still wired somewhere despite the migration to
   versioned SQL.
2. **Migrations 0050+ were applied manually** out of band (e.g. a one-off
   psql session against the production DB).
3. **Production hasn't been redeployed since the journal was last in
   sync** — i.e. it's still running an older artifact. (Unlikely given
   recent feature work touching these tables, but worth confirming.)

The repo cannot answer "which one" — only an inspection of production's
`drizzle.resupply_migrations` table can.

## Why a code-only fix is unsafe

The naïve approach (rename the newer-of-each-pair, regenerate the
journal) breaks under any of those scenarios:

- **If production applied the SQL files under their current names** (via
  `drizzle-kit push` or manual psql), production's
  `drizzle.resupply_migrations` table contains the original tags. After
  a rename + journal rebuild, those tags no longer match the new file
  names → `migrate.mjs` either fails on a "missing migration referenced
  in DB" check or, worse, treats them as new and tries to re-apply
  changes that already exist (e.g. `CREATE TABLE patient_therapy_links`
  → 42P07 duplicate object error mid-deploy).
- **If production used `drizzle-kit generate` mid-deploy**, the journal
  it produced may not match the one we'd rebuild from the current TS
  schema (timestamps and hashes differ). That would generate "new"
  migrations on the next run.
- **If production hasn't redeployed**, then we're rebuilding on a stale
  baseline; the next deploy attempts a from-scratch reapply that races
  with whatever else is in flight.

## What needs to happen first

This work is gated on **two facts about production**, neither of which
is visible from the repo:

1. The full contents of `drizzle.resupply_migrations` on production —
   specifically the `hash` and `created_at` columns for every recorded
   tag. This tells us which file content corresponds to which recorded
   migration, so we can preserve the chain across a rename.
2. The actual deploy command sequence. If `drizzle-kit generate` runs
   before `migrate.mjs`, the journal in the repo is regenerated on
   every deploy and the on-disk state is moot. If not, the on-disk
   journal is the source of truth and we must rebuild it carefully.

Once we have those, the safe procedure is:

1. Build the new (post-rename) journal locally.
2. For each duplicate-prefix pair, decide canonical order based on
   production's `created_at` ordering — whichever was applied first
   wins the lower idx slot.
3. Compute the new file hashes; if they match what production has
   recorded under the old tag, only update the _tag_ in
   `drizzle.resupply_migrations` (a one-row UPDATE per renamed file)
   in lockstep with the deploy. If hashes differ, the migration was
   applied via `push` and we cannot rename without a `--no-op` shim
   migration that asserts the resulting state.
4. Land the rename + journal change + the prod UPDATE script as a
   single coordinated change with rollback.

## Recommendation

**Treat P0.1 + P0.2 as an ops task, not a code task.** Open a separate
ticket that owns:

- The production-state inspection (read-only psql query).
- The deploy-mechanism audit (does `generate` run before `migrate`?).
- A coordinated migration-tag rewrite, scheduled in a maintenance window.

Until those are answered, the cleanest harm-reduction step from this
codebase alone is **leave the SQL files and journal in the current
shape**. They're stable. The cost is the drift warning in
`scripts/check-drizzle-drift.sh` (currently a `continue-on-error: true`
job in CI per P0.3); the benefit is that nothing breaks at deploy.

## Open questions to resolve before re-attempting

1. Does production's `drizzle.resupply_migrations` table actually have
   rows for the 0050+ migrations? `psql -c "SELECT migration_name FROM
drizzle.resupply_migrations ORDER BY created_at"` — paste the
   output into the follow-up ticket.
2. Does the deploy pipeline run `pnpm --filter @workspace/resupply-db
run generate` (or any drizzle-kit command) before `migrate.mjs`? If
   yes, the on-disk journal isn't authoritative and this whole question
   needs reframing.
3. Are any of the post-Phase-G feature flags (smart triggers, fax
   outreach, patient documents, facial measurements) actually live on
   production today? If they are, prod definitely has the schema, and
   the journal-vs-files mismatch is purely a deploy-pipeline drift
   that can be reconciled. If they aren't, the schema may genuinely
   not be applied.
