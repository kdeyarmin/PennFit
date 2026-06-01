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

## Procedure

> Run from a machine with the **production** `DATABASE_URL` exported. The
> migrator takes a session advisory lock, so it is safe to run while the app
> is live. Each migration commits in its own transaction.

```bash
export DATABASE_URL='postgresql://…prod…'

# 1. Baseline the already-applied range (stamps the ledger, runs NO SQL).
node lib/resupply-db/scripts/migrate.mjs --baseline-through=0187

# 2. Apply the pending tail (0188.. plus anything unledgered above the
#    cutoff). Review the printed "applied …" list.
node lib/resupply-db/scripts/migrate.mjs

# 3. Verify: table count matches a fresh full replay; ledger is populated.
```

### The `0149` seed caveat

`0149_pa_payers_phase2` is **below** the cutoff (so it gets baselined as
"applied"), but its **seed of 25 payers never actually ran on prod** — only
its columns were backfilled (via `0186`). After the steps above, prod still
has 26 of 51 payers. The `0149` body is fully idempotent (`ADD COLUMN IF NOT
EXISTS`, DO-guarded constraints, `INSERT … ON CONFLICT (slug) DO NOTHING`),
so apply just its seed once, then re-run the (idempotent) `0206`/`0207`
payer migrations so the newly-inserted rows get their derived fields + PA
notes:

```bash
# Apply the 0149 INSERT block (idempotent) + re-run 0206/0207. These can be
# run directly against prod via the Supabase SQL editor / MCP since all three
# are idempotent and were validated against a full-chain replay.
```

(If you prefer the migrator to do it: `DELETE FROM drizzle.resupply_migrations
WHERE hash = '<sha256 of 0149 file>'` then re-run `migrate.mjs` — it will
re-apply `0149` idempotently. `0206`/`0207` are above the cutoff and already
ran in step 2.)

## Turn on auto-migrate

Once the ledger is baselined and the tail is applied:

1. Set **`RUN_DB_MIGRATIONS=true`** on the Railway service.
2. Redeploy. From now on every deploy runs `migrate.mjs` in the
   `preDeployCommand`. A migration error **fails the deploy** and Railway
   keeps the previous release live (it does not take the site down).

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
