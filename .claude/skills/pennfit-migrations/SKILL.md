---
name: pennfit-migrations
description: How to safely write, review, test, and ship PennFit database migrations — the repo's #1 footgun area (multiple production incidents). Covers the hand-written-SQL + content-hash ledger model, the frozen `_journal.json`, the immutability rule (never edit a shipped migration), the prefix moratorium, idempotency (including why a destructive statement makes a migration un-editable), transaction opt-out, the `RUN_DB_MIGRATIONS` deploy gate, the one-time ledger baseline, and the rule that a clinical reference-data import never clears `needs_clinical_review` (a provenance record, not a confidence gate). Use whenever adding/editing/reviewing a `lib/resupply-db/migrations/*.sql` file, making a schema change (CREATE/ALTER TABLE, index, enum, backfill), importing clinical reference data (mask size bands, safety rules) from a vendor document, diagnosing a failed deploy-time migration, or baselining/adopting the ledger.
---

# PennFit migration safety

Schema changes are the most dangerous thing you can do in this repo —
they have caused several production incidents (see `docs/`:
`migration-state-investigation-2026-05-08`,
`db-schema-drift-2026-05-29`, `incident-signin-500-schema-drift-2026-05-30`,
`prod-schema-reconcile-2026-05-31`). Read this before touching
`lib/resupply-db/migrations/`.

## The model (know this first)

- **Supabase (PostgREST) is the runtime data path, but schema changes are
  NOT.** Schema is hand-written SQL in `lib/resupply-db/migrations/*.sql`,
  applied by `lib/resupply-db/scripts/migrate.mjs` (raw `pg`). There is no
  ORM (no `drizzle-orm`/`drizzle-kit`) — migrations are plain SQL files.
- **The ledger dedups by CONTENT HASH, not filename.** Applied migrations
  are tracked in `migrations.resupply_migrations(id, hash, created_at)`. A file
  is "pending" iff its **sha256(content)** is not already in the ledger.
  Two consequences drive every rule below: (1) editing a shipped file
  changes its hash → it re-applies; (2) the filesystem (not the journal) is
  the source of truth for "what migrations exist".
- **`meta/_journal.json` is FROZEN at 52 entries** (~252 `.sql` files on
  disk). New migrations are **not** journaled. The migrator reads files off
  disk and ignores the journal for ordering. Migrations apply in
  **numeric-prefix order**.

## Hard rules — violating these can break production deploys

### M1 — NEVER edit, delete, or rename a shipped migration
A migration that already exists on the base branch is immutable. Editing it
changes its content hash, so the deploy-time migrator treats it as **pending
and re-applies it against production**. If the rewritten SQL isn't perfectly
idempotent, the re-apply errors and **gates the deploy**. This is exactly
what broke every Railway release on 2026-06-05 (an in-place idempotency edit
to `0212_compliance_rules.sql` re-ran a bare `CREATE TRIGGER` that already
existed).
- **Fix:** add a NEW, higher-numbered, idempotent corrective migration that
  brings the schema to the desired state. Never edit in place.
- **Escape hatch (rare):** add the basename to
  `lib/resupply-db/migrations/.migration-edit-allowlist` in the same change so
  the override is reviewed in the PR diff; remove it once shipped.
- **Enforced by** `scripts/check-resupply-migration-immutability.sh`
  (pre-commit + CI; CI honors only the allowlist, not `--no-verify`).

### M2 — NEVER hand-edit `meta/_journal.json`
It is frozen at 52 entries. Splicing/rebuilding it can make `migrate.mjs`
re-apply or skip migrations against production. Its `-diff merge=binary`
marker is only a guard; if it ever conflicts, take **either side verbatim**.

### M3 — New prefix must be > 0066 AND collision-free
Pick the next free 4-digit prefix above the current maximum. A prefix `<=
0066` lands in the duplicated/unjournaled drift range; a prefix already used
by another file makes apply order filesystem-dependent (a fresh deploy may
apply one of the pair and silently skip the other).
- Find the next prefix:
  ```bash
  ls lib/resupply-db/migrations/*.sql \
    | sed -E 's#.*/([0-9]{4})_.*#\1#' | sort -n | tail -1
  # next = that + 1, zero-padded to 4 digits (e.g. 0230 → 0231)
  ```
  Name it `NNNN_short_snake_description.sql`.
- **Enforced by** `scripts/check-resupply-migration-prefix.sh`.

### M4 — Write idempotent SQL
Both fresh-replay (CI/preview) and re-apply scenarios happen, so every
migration must be safe to run more than once:
`CREATE TABLE/INDEX ... IF NOT EXISTS`, `DROP ... IF EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`,
slug/id-targeted `UPDATE`s, and guarded `DO $$ ... $$` blocks for
constraints/enum values that lack an `IF NOT EXISTS`.

**"Idempotent" is not the same as "safe to re-apply later."** A `DELETE`
or a destructive `UPDATE` re-run from the *same* state is a no-op, so it
looks idempotent — but an M1 edit re-applies it months later against a
database that has moved on, and it then destroys rows created since.
`0499_eson2_manufacturer_bands.sql` is the live example: it deletes stale
`mask_variant_reviews` for the variants it rewrites, which is correct on
first apply and would wipe every clinician sign-off recorded since on a
re-apply. **A migration containing a destructive statement is effectively
un-editable** — not even a comment fix, because the hash covers comments
too. Get it right the first time, and prefer a targeted `WHERE` (bounded
by id/slug *and* a timestamp or a status column) over a broad one.

### M5 — Statement splitting + transaction opt-out
- Statements are split on the literal line `--> statement-breakpoint`. The
  split is naive — **do not put that literal inside a function body or
  string**.
- Each migration is wrapped in `BEGIN/COMMIT` per file by default. For
  statements that refuse to run in a transaction (`CREATE INDEX
  CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` on older PG, `VACUUM`,
  `REINDEX CONCURRENTLY`), make the **first non-blank line** exactly:
  ```sql
  -- migrate: no-transaction
  ```
  No-transaction failures leave partial state — recover by hand.

### M6 — Schema placement + Supabase exposure
Tables live in `resupply.*` (runtime) and `resupply_auth.*` (auth); the
ledger is `migrations.resupply_migrations`. The migrator pre-creates the
`migrations`, `auth`, `resupply`, and `resupply_auth` schemas (and renames a
legacy `drizzle` history schema into `migrations` on first run). **Any new schema
must be added to Supabase Studio → Project Settings → API → "Exposed
schemas"** or every PostgREST query against it 503s at runtime.

### M7 — An import never certifies its own clinical data
A migration that loads clinical reference data (mask size bands, safety
rules, therapy thresholds) **must leave `needs_clinical_review = TRUE`**
and must never set a review/approval row on a tenant's behalf. Vendor
documents are not pre-verified inputs.

Note the flag's scope changed: it used to cap patient-facing confidence,
and that gate was **removed on purpose** (see `pennfit-rules` R8). It now
drives the admin review queue and the "pending clinical review" line on
the fit report. So an import that cleared it would no longer inflate a
score — it would instead make the queue claim work nobody did and the
report print a review that never happened. Still a bug; different
blast radius.

**The evidence is concrete, not hypothetical.** Fisher & Paykel's REF
620198 (the source for `0499`) prints, in its nasal table:

> Greater than 5.2 cm **(2.95 inches)**

5.2 cm is **2.05** inches; the row directly above converts the same value
correctly, and the error survives all three revisions across five years.
Transcribing the inch column would have put the M/L nose-height boundary
at 74.9 mm instead of 52.0 — and since `PLAUSIBILITY_BOUNDS` caps nose
height at 70 mm, the Large band would have started *above* the largest
measurement the scanner will accept. Large becomes unreachable: not
mis-recommended, silently absent. A human reading the table next to the
diagram catches that in seconds; no importer will.

Two corollaries when writing an import:
- **Invalidate prior sign-offs for anything you rewrite in place.**
  `mask_variant_reviews` is keyed on `size_variant_id`, so an in-place
  `UPDATE` keeps the UUID and a tenant's old approval carries over to new
  geometry — leaving the record asserting a clinician checked numbers
  that have since been replaced. (Then re-read M4: that `DELETE` is what
  makes the migration un-editable.)
- **Don't attribute what the source doesn't contain.** `fit_data_source`
  is row-level, so every non-NULL band on the row inherits the citation.
  `NULL` out dimensions the cited document is silent on rather than
  letting `scoreVariant` average uncited estimates under a real citation.

Background — what each manufacturer actually publishes, and why only one
model is imported: [`docs/mask-sizing-data-sources-2026-08-18.md`](../../../docs/mask-sizing-data-sources-2026-08-18.md).

## Adding a migration — the procedure

1. **Pick the next free prefix** (M3) and create
   `lib/resupply-db/migrations/NNNN_description.sql`.
2. **Write idempotent SQL** (M4), splitting statements with
   `--> statement-breakpoint` (M5). Add `-- migrate: no-transaction` as the
   first line only if required.
3. **Do NOT touch `_journal.json`** (M2).
4. **Test on a throwaway DB** — prove a fresh replay works AND that it's
   idempotent:
   ```bash
   DATABASE_URL=postgres://… node lib/resupply-db/scripts/migrate.mjs   # apply
   DATABASE_URL=postgres://… node lib/resupply-db/scripts/migrate.mjs   # re-run = no-op, 0 applied
   ```
5. **Run the guards** before committing:
   ```bash
   bash scripts/check-resupply-migration-prefix.sh
   bash scripts/check-resupply-migration-immutability.sh
   ```

## Deploy mechanics

- `railway.json` `preDeployCommand` runs `deploy-migrate.mjs`, which invokes
  the migrator **once per deploy, before the new release goes live, and
  gates the deploy on success** — a migration error keeps the previous
  release running (it does **not** take the site down).
- It is **opt-in**: it runs only when `RUN_DB_MIGRATIONS=true` (unset = safe
  no-op). Production must be **baselined once** before enabling the flag.
- The migrator takes a **session advisory lock** (safe to run while live)
  and commits **per migration**, so a later failure doesn't roll back
  earlier successes.

### Adoption guard + baselining
`migrate.mjs` refuses a destructive full `0000..` replay onto a **populated
database with an empty ledger** (it would fail on the first non-idempotent
historical statement). To adopt the ledger on such a DB, baseline the
already-applied range, then apply the pending tail:
```bash
node lib/resupply-db/scripts/migrate.mjs --baseline-through=<last-applied-prefix> \
  [--baseline-except=<tag>,<tag>]   # stamp <=cutoff as applied WITHOUT running
node lib/resupply-db/scripts/migrate.mjs   # apply the pending tail
```
`--baseline-except` leaves a sub-cutoff migration **pending** (use when its
columns exist but its backfill/seed never ran). The same flow is available
from env via `MIGRATIONS_BASELINE_THROUGH` / `MIGRATIONS_BASELINE_EXCEPT`.
Full procedure: [`docs/runbooks/adopt-migration-ledger.md`](../../../docs/runbooks/adopt-migration-ledger.md).

### `migrate.mjs` reference
- Exit codes: `0` applied/up-to-date · `1` migration failed · `2`
  `DATABASE_URL` unset.
- Flags: `--baseline-through=<prefix>`, `--baseline-except=<tags>`.

## When a deploy-time migration fails

The previous release stays live — the site is **not** down; you have time to
fix forward. Diagnose, then ship a corrective migration:
1. **Was a shipped file edited?** (M1) — its re-apply collided. Revert the
   edit; write a new idempotent corrective migration instead.
2. **Non-idempotent statement?** (M4) — add `IF NOT EXISTS` / `IF EXISTS` /
   `ON CONFLICT` guards in a new migration.
3. **Was `_journal.json` spliced?** (M2) — revert it.
Never "fix" by editing the failing shipped file in place — that just changes
its hash again and re-triggers the re-apply.

## Pointers

- `lib/resupply-db/scripts/migrate.mjs` — the migrator (read the header).
- `scripts/check-resupply-migration-{immutability,prefix}.sh` — the guards.
- `docs/runbooks/adopt-migration-ledger.md` — one-time ledger adoption.
- `docs/migration-state-investigation-2026-05-08.md` — why the journal is
  frozen and a code-only fix is unsafe.
- `docs/mask-sizing-data-sources-2026-08-18.md` — what manufacturers
  publish, the REF 620198 conversion error, and the M7 reasoning.
