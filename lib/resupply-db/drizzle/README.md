# `lib/resupply-db/drizzle/` — migration directory

> **Note:** Drizzle has been fully retired. New migrations are hand-written SQL
> applied by `scripts/migrate.mjs` via raw `pg`. The directory and the on-DB
> `drizzle.resupply_migrations` history table keep their Drizzle-era names so
> the existing production rows continue to gate new migrations cleanly.

## Adding a migration

1. Create a new `.sql` file with a 4-digit numeric prefix that is strictly
   higher than any existing file and unique (no other file uses that prefix).
   Find the next free prefix with:
   ```bash
   ls lib/resupply-db/drizzle/*.sql | sed -E 's#.*/([0-9]{4})_.*#\1#' | sort -n | tail -1
   ```
2. The pre-commit hook (`scripts/check-resupply-migration-prefix.sh`) and the
   CI drift job both reject any addition that collides with an existing prefix.
3. The migrator (`scripts/migrate.mjs`) applies every `.sql` file in
   numeric-prefix order (ties broken lexicographically by tag). It deduplicates
   by SHA256 content hash, so a migration is a no-op on any database that has
   already applied it.

## Duplicate prefixes — historical, load-bearing, do NOT "fix"

The tree contains ~30 legacy files whose 4-digit prefix collides with another
file (22 collision groups: `0016`–`0257`). They arose from concurrent PRs that
each picked the same "next" prefix, and `migrate.mjs` warns about each one on
every deploy. **The warnings are cosmetic; the filenames are load-bearing.**

Renaming a shipped migration never re-runs it in production (dedup is by
content hash, not filename) — but it DOES change the apply **order** on every
fresh database (CI replay, preview envs, future environments). The chain has
grown real order dependencies, in both directions:

- later migrations reference columns/tables a duplicate-prefixed file creates
  (`0206` needs `era_payer_id` from `0142_payer_profile_completeness`;
  `0219` alters `patient_integration_snapshots` from `0065_…`;
  `0258` needs `signature_tracking` from `0254_…`), and
- some duplicate-prefixed files reference objects a LATER migration drops
  (`0149_clinician_share_tokens` FK-references `inbound_referral_orders`,
  which `0220_drop_inbound_referral_subsystem` removes — so it can never
  apply after `0220`).

PR #662 (2026-06-10) renamed all 30 to fresh prefixes `0264`–`0293` on the
assumption that ordering didn't matter; the from-scratch CI replay broke in
at least five places and the renames were reverted the same day. Any future
attempt to renumber the chain must move every dependent migration together,
prove the result with a full from-scratch replay, and ship as one change.

## `meta/_journal.json`

This file is **frozen** and no longer appended to — new migrations are not
journaled. The migrator reads `_journal.json` only to recover the original
`when` timestamp for journaled files (used as the `created_at` value in the
history table); it applies all SQL files regardless of journal coverage.

**Do not hand-edit `meta/_journal.json`.** If it ever conflicts in a merge,
take either side verbatim (see `CLAUDE.md`).

## Immutability

A migration that exists on `main` must never be edited, deleted, or renamed —
add a new, higher-numbered, idempotent corrective migration instead. Enforced
by `scripts/check-resupply-migration-immutability.sh` (pre-commit + CI); the
narrow escape hatch is `.migration-edit-allowlist` in this directory. The
full incident history is in
[`docs/migration-state-investigation-2026-05-08.md`](../../../docs/migration-state-investigation-2026-05-08.md).
