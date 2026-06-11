# `lib/resupply-db/drizzle/` — migration directory

> **Note:** Drizzle has been fully retired. New migrations are hand-written SQL
> applied by `scripts/migrate.mjs` via raw `pg`. The directory and the on-DB
> `drizzle.resupply_migrations` history table keep their Drizzle-era names so
> the existing production rows continue to gate new migrations cleanly.

## Adding a migration

1. Create a new `.sql` file with a 4-digit numeric prefix that is strictly
   higher than any existing file and unique (no other file uses that prefix).
   As of this writing the highest is `0306`; use `0307` for the next migration.
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
File _content_ was not changed, so the SHA256 hashes are unchanged; production
databases already record those hashes in `drizzle.resupply_migrations` and
the migrator correctly treats the renamed files as already-applied.

### Follow-up — replay-order repair (June 2026)

Pushing the renamed files to the end of the chain broke from-scratch replay
order for the ones other migrations depend on (e.g. `0206` UPDATEs payer
columns that the renamed `0142_payer_profile_completeness` creates, and the
renamed `0157_inbound_webhooks_processing_status` ALTERs a table that `0220`
drops). The repair was a second round of pure renames (content untouched, so
still hash-no-ops for production) that put every such file back before its
first consumer / after its last dependency:

| file                                 | moved to |
| ------------------------------------ | -------- |
| `payer_profile_completeness`         | `0175`   |
| `pa_payers_phase2`                   | `0176`   |
| `patient_integration_snapshots`      | `0177`   |
| `inbound_webhooks_processing_status` | `0204`   |
| `clinician_share_tokens`             | `0205`   |
| `inbound_fax_auto_file`              | `0294`   |
| `provider_portal_esign_tables`       | `0295`   |

Two standalone leaf migrations were rotated up to free the `0204`/`0205`
slots (`clinical_outreach_log` → `0258`, `education_videos` → `0269`), and
`0296_restore_therapy_fleet_rpcs` re-asserts the `0212` therapy-fleet
function bodies that the renamed `0283` (old `0179`) would otherwise
overwrite with stale ones on a fresh replay. Prefix gaps left behind by the
rotation are expected and harmless.

## `meta/_journal.json`

This file is **frozen** at 53 entries (last: `0157_backfill_missing_inbound_tables`)
and is no longer appended to — new migrations are not journaled. The migrator
reads `_journal.json` only to recover the original `when` timestamp for
journaled files (used as the `created_at` value in the history table); it
applies all SQL files regardless of journal coverage.

**Do not hand-edit `meta/_journal.json`.**
