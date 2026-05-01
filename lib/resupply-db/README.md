# @workspace/resupply-db

Drizzle schema + Postgres connection for the CPAP resupply system. Owns the patients, equipment, supplies, orders, consents, suppression, audit, outbound-message, and conversation tables. Patient fields are stored as plaintext `text`/`jsonb`; column-level pgcrypto encryption was removed in migration `0025_strip_phi_encryption.sql`. ADR 003's hand-authored migration contract still applies.

## Status

Phase 0 — scaffolding only. No exports yet. See `docs/resupply/adr/` for the
architectural decisions that govern this package.

## Schema-drift guard (deferred)

The sibling `@workspace/db` package is covered by
`scripts/check-drizzle-drift.sh`, which fails CI when a schema TypeScript
file drifts from the committed migrations. This package is **not** in
that check yet: `drizzle/meta/_journal.json` lists only snapshot tags
through `0003_admin_rename`, while 25+ migration SQL files have shipped
(many hand-authored per ADR 003 without rebuilding the snapshot chain).
`drizzle-kit generate` short-circuits with a "snapshot collision"
error against this state, so the drift check would have nothing
meaningful to compare. Once the snapshot chain is repaired (rebuild
`drizzle/meta/000N_snapshot.json` for every tag in `_journal.json` so
the chain is continuous), add this lib to the `LIBS` array in
`scripts/check-drizzle-drift.sh` and add the matching path globs to
`scripts/git-hooks/pre-commit`.
