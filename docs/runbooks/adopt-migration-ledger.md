# Runbook: adopt the migration ledger on production (one-time)

## Why this exists

Until June 2026 the Railway deploy ran **no migration step** — `migrate.mjs`
was never invoked on deploy or boot — so production drifted behind the
`lib/resupply-db/drizzle/*.sql` history. As of the migrate-on-deploy change,
`railway.json` has a `preDeployCommand` that runs the migrator, gated by the
`RUN_DB_MIGRATIONS` env var.

Production cannot simply turn that on, because it has **no
`drizzle.resupply_migrations` ledger** while already carrying most of the
schema. A naive run would attempt a full `0000..` replay and fail on the
first non-idempotent historical statement whose object already exists. The
migrator now **guards against that**: on a populated database with an empty
ledger it aborts and points here.

This runbook adopts the ledger safely: stamp the already-applied range, then
let a normal run apply the pending tail.

## Determining the cutoff

Find the highest migration prefix whose effects are fully present on prod.
As of 2026-06, prod has everything **through `0187`** (the `fhir_jwt_jti_seen`
table from `0187` exists; none of the `0188`–`0205` feature tables do), so
the cutoff is **187**. Re-confirm before running — compare prod's tables to a
fresh full replay:

```bash
# fresh full schema (local throwaway PG), then:
#   SELECT table_name FROM information_schema.tables
#   WHERE table_schema='resupply' AND table_type='BASE TABLE';
# diff against the same query on prod; the missing tables tell you the
# first unapplied migration → cutoff = (that prefix) - 1.
```

### The payer-data caveat (why `--baseline-except`)

`0175_payer_profile_completeness` and `0176_pa_payers_phase2` are **below**
the cutoff, but their **value backfill + 25-payer seed never ran on prod** —
only their columns were added (via `0186`). So they must NOT be baselined as
"applied"; they need to actually run (both are fully idempotent: `ADD COLUMN
IF NOT EXISTS`, DO-guarded constraints, `INSERT … ON CONFLICT DO NOTHING`,
slug-targeted `UPDATE`s). `--baseline-except` leaves them pending so the
normal run re-applies them ahead of `0206`/`0207` (which then reconcile +
PA-note all 51 payers). Confirm with a fresh full-replay diff before relying
on the exact cutoff/except set.

## Procedure A — env-driven, via the deploy hook (recommended, no shell)

The `preDeployCommand` (`deploy-migrate.mjs`) performs the whole one-time
adoption from env vars, using the service's own `DATABASE_URL`. On the
Railway service, for **one** deploy set:

```
RUN_DB_MIGRATIONS=true
MIGRATIONS_BASELINE_THROUGH=0187
MIGRATIONS_BASELINE_EXCEPT=0175_payer_profile_completeness,0176_pa_payers_phase2
```

then deploy. The hook baselines `0000–0187` (except the two payer
migrations), then applies the pending set: `0175` + `0176` (backfill +
25-payer seed) and the `0188–0207` tail (15 tables + `0206`/`0207`
reconcile). The deploy is gated on success (a failure keeps the previous
release live).

**After the cutover deploy succeeds, delete `MIGRATIONS_BASELINE_THROUGH`
and `MIGRATIONS_BASELINE_EXCEPT`** (leave `RUN_DB_MIGRATIONS=true`). From
then on every deploy runs a normal (usually no-op) migrate. Re-running with
the baseline vars still set is harmless — the baseline is idempotent.

End state to expect: **51 payers** (50 with claims/flat addresses; only the
`pa_chip` umbrella has none), **51 PA notes**, **~152 base tables**, ledger
fully populated (227 rows), 0 payers at `enrollment_status='unknown'`.

> **Update (verified 2026-06-06, production through migration `0224`).** The
> counts above are the snapshot at the `0207` cutover. Production has since
> applied the `0208`–`0224` tail (national / workers' comp / auto / CHIP payer
> cohorts), so the live numbers are now a superset: **107 payers**, **254
> ledger rows**, **153 base tables**. The adoption invariants still hold —
> **0 payers at `enrollment_status='unknown'`** (distribution: 60 `active` /
> 28 `not_required` / 19 `pending`), the original `0207` **`[PA]` note cohort
> is intact at 51**, and there are no duplicate slugs or null payer names. So
> read `51 / 227 / ~152` as the historical cutover snapshot, not a live health
> check — the ledger is fully adopted and there are **0 pending migrations**.

## Procedure B — manual CLI (alternative; needs shell + prod `DATABASE_URL`)

> The migrator takes a session advisory lock, so it is safe to run while the
> app is live; each migration commits in its own transaction. Easiest with a
> Railway one-off shell (`railway run --service <api> bash`), which injects
> the service `DATABASE_URL`.

```bash
# 1. Baseline 0000–0187, leaving the two payer migrations pending.
node lib/resupply-db/scripts/migrate.mjs \
  --baseline-through=0187 \
  --baseline-except=0175_payer_profile_completeness,0176_pa_payers_phase2

# 2. Apply the pending set (the two payer migrations + the 0188–0207 tail).
node lib/resupply-db/scripts/migrate.mjs

# 3. Verify table count + payer count + ledger as above.
```

## After adoption: auto-migrate is on

With `RUN_DB_MIGRATIONS=true` (and the baseline vars removed), every deploy
runs `migrate.mjs` in the `preDeployCommand`. A migration error **fails the
deploy** and Railway keeps the previous release live (it does not take the
site down).

## Rollback / safety notes

- The `preDeployCommand` is **opt-in**: with `RUN_DB_MIGRATIONS` unset it is a
  no-op, so the hook is safe to ship before this runbook is executed.
- To pause auto-migrate, unset `RUN_DB_MIGRATIONS` (or set it to anything but
  `true`) and redeploy.
- The adoption guard only fires on the populated-but-unledgered case; fresh
  databases (CI, local, preview) replay from `0000` as before, and a healthy
  ledgered database applies only the pending tail.
- Never hand-edit `lib/resupply-db/drizzle/meta/_journal.json` (frozen at 52
  entries — see `docs/migration-state-investigation-2026-05-08.md`).
