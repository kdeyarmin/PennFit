# `lib/resupply-db/drizzle/` — migration directory

> **Note:** Drizzle has been fully retired. New migrations are hand-written SQL
> applied by `scripts/migrate.mjs` via raw `pg`. The directory and the on-DB
> `drizzle.resupply_migrations` history table keep their Drizzle-era names so
> the existing production rows continue to gate new migrations cleanly.

## Adding a migration

1. Create a new `.sql` file with a 4-digit numeric prefix that is strictly
   higher than any existing file and unique (no other file uses that prefix).
   As of this writing the highest is `0293`; use `0294` for the next migration.
2. The pre-commit hook (`scripts/check-resupply-migration-prefix.sh`) and the
   CI drift job both reject any addition that collides with an existing prefix.
3. The migrator (`scripts/migrate.mjs`) applies every `.sql` file in
   numeric-prefix order. It deduplicates by SHA256 content hash, so a migration
   is a no-op on any database that has already applied it.

## History — duplicate prefixes (resolved)

Prior to June 2026 the tree had 30 migration files whose 4-digit prefix
collided with another file. These arose from concurrent PRs that each picked
the same "next" prefix without knowing about each other. They caused
`migrate.mjs` to emit `WARNING: duplicate migration prefix …` on every deploy.

All duplicates were resolved by renaming the lexicographically-second (and
third/fourth) file in each group to a fresh prefix in the 0264–0293 range.
File *content* was not changed, so the SHA256 hashes are unchanged; production
databases already record those hashes in `drizzle.resupply_migrations` and
the migrator correctly treats the renamed files as already-applied.

## `meta/_journal.json`

This file is **frozen** at 53 entries (last: `0157_backfill_missing_inbound_tables`)
and is no longer appended to — new migrations are not journaled. The migrator
reads `_journal.json` only to recover the original `when` timestamp for
journaled files (used as the `created_at` value in the history table); it
applies all SQL files regardless of journal coverage.

**Do not hand-edit `meta/_journal.json`.**
