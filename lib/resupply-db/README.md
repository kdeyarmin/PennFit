# @workspace/resupply-db

Drizzle schema + Postgres connection for the CPAP resupply system. Owns the patients, equipment, supplies, orders, consents, suppression, audit, outbound-message, and conversation tables. Patient fields are stored as plaintext `text`/`jsonb`; column-level pgcrypto encryption was removed in migration `0025_strip_phi_encryption.sql`. ADR 003's hand-authored migration contract still applies.

## Status

Phase 0 — scaffolding only. No exports yet. See `docs/resupply/adr/` for the
architectural decisions that govern this package.

## Schema-drift guard

This package is guarded against the "edited the schema, forgot the
migration" failure mode by **two** layered checks:

1. `scripts/check-resupply-migration-pair.sh` — a **co-change rule**:
   any commit that modifies a file under `src/schema/` must also add
   a new migration SQL file under `drizzle/`. Runs from the
   pre-commit hook and is exercised by
   `scripts/check-resupply-migration-pair.sh.test`.

2. `scripts/check-drizzle-drift.sh` — a **structural check**: runs
   `drizzle-kit generate` and asserts no new files would be emitted.
   Catches subtle mismatches the co-change rule can't (e.g. "I
   edited the schema **and** committed an unrelated migration in the
   same commit"). Self-tested by
   `scripts/check-drizzle-drift.sh.test` against a sandboxed clone
   of this lib.

### Snapshot meta layout

`drizzle/meta/_journal.json` lists every shipped migration (idx
0–29 → tags 0000–0027, with two duplicate-numbered pairs at 0016/0017
that ADR 003 explicitly allows). The runtime migrator
(`scripts/migrate.mjs`) hashes each journal entry against
`drizzle.resupply_migrations` and **requires the journal + SQL files
to stay byte-identical** to what production has applied. Renaming or
re-tagging would cause it to reject the deploy or attempt to re-apply
already-applied migrations.

`drizzle/meta/` itself, however, only needs to satisfy
`drizzle-kit generate`. drizzle-kit walks the prevId chain across
every snapshot file present in `meta/` and only diffs the schema
against the **last** (highest-indexed) one. Task #39 collapsed the
old, partial snapshot chain (0000–0003 only) into a single
**consolidated snapshot** named to match the last journal entry's
idx — currently `0029_snapshot.json`. This is enough for drift
detection without forcing us to backfill 30 historically-accurate
intermediate snapshots.

### Rebuilding the snapshot meta

If a future migration grows the journal (say to idx 30) the
consolidated snapshot must be rebuilt at the new index. The
procedure is reproducible in-place:

```sh
cd lib/resupply-db
# 1. Stash the current journal + SQL files (they MUST stay byte-
#    identical for production).
mkdir -p /tmp/drizzle-stash
cp -a drizzle/. /tmp/drizzle-stash/

# 2. Empty drizzle/ so drizzle-kit regenerates from scratch as a
#    single consolidated baseline.
rm -f drizzle/*.sql
rm -rf drizzle/meta

# 3. Generate the consolidated snapshot.
DATABASE_URL="postgres://drift-rebuild/none" \
  pnpm exec drizzle-kit generate

# 4. Capture the just-generated snapshot, then restore originals.
cp drizzle/meta/0000_snapshot.json /tmp/drizzle-stash/_consolidated_snapshot.json
rm -f drizzle/0000_*.sql
rm -f drizzle/meta/0000_snapshot.json
cp /tmp/drizzle-stash/*.sql drizzle/
cp /tmp/drizzle-stash/meta/_journal.json drizzle/meta/_journal.json

# 5. Install the consolidated snapshot at the LAST journal idx
#    (e.g. 0030 if the new entry is at idx=30). The 4-digit prefix
#    must equal the highest "idx" field in _journal.json.
cp /tmp/drizzle-stash/_consolidated_snapshot.json drizzle/meta/<NN>_snapshot.json

# 6. Verify: drift checker should report no changes.
DATABASE_URL="postgres://drift-rebuild/none" \
  bash ../../scripts/check-drizzle-drift.sh
```

Then commit only the new `<NN>_snapshot.json` (the SQL + journal
should be byte-identical to before).
