# @workspace/resupply-db

Drizzle schema + Postgres connection for the CPAP resupply system. Owns the patients, equipment, supplies, orders, consents, suppression, audit, outbound-message, and conversation tables. Patient fields are stored as plaintext `text`/`jsonb`; column-level pgcrypto encryption was removed in migration `0025_strip_phi_encryption.sql`. ADR 003's hand-authored migration contract still applies.

## Status

Phase 0 — scaffolding only. No exports yet. See `docs/resupply/adr/` for the
architectural decisions that govern this package.

## Schema-drift guard

This package is guarded against the "edited the schema, forgot the
migration" failure mode by `scripts/check-resupply-migration-pair.sh`
— a **co-change rule**: any commit that modifies a file under
`src/schema/` must also add a new migration SQL file under `drizzle/`.
The check runs from the pre-commit hook (see
`scripts/git-hooks/pre-commit`'s `need_resupply_pair` branch) and is
exercised by the companion self-test
`scripts/check-resupply-migration-pair.sh.test`.

The co-change rule is intentionally weaker than the structural
`scripts/check-drizzle-drift.sh` check that protects the sibling
`@workspace/db` package. The structural check uses `drizzle-kit
generate` to byte-compare a regenerated migration tree against what
is committed, which catches subtle mismatches the co-change rule
cannot (e.g. "I edited the schema **and** committed an unrelated
migration in the same commit"). It can't run here because
`drizzle/meta/_journal.json` already lists every shipped migration
(0000–0025+) but `drizzle/meta/` only contains snapshot files for tags
0000–0003. With a discontinuous snapshot chain `drizzle-kit generate`
short-circuits with a "snapshot collision" before computing a diff.

Path to upgrade: rebuild `drizzle/meta/000N_snapshot.json` for every
tag listed in `_journal.json` so the chain is continuous, then add
this lib to the `LIBS` array in `scripts/check-drizzle-drift.sh` and
add the matching path globs to `scripts/git-hooks/pre-commit`'s
`need_drizzle` branch. The co-change check can stay alongside the
structural check or be retired at that point — they catch
overlapping but not identical failure modes. The repair work is
tracked as a follow-up project task and called out in
`scripts/check-drizzle-drift.sh`'s header.
