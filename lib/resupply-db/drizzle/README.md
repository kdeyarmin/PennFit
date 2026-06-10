# `lib/resupply-db/drizzle/` — migration directory

> **Note:** Drizzle has been fully retired. New migrations are hand-written SQL
> applied by `scripts/migrate.mjs` via raw `pg`. The directory and the on-DB
> `drizzle.resupply_migrations` history table keep their Drizzle-era names so
> the existing production rows continue to gate new migrations cleanly.

## Adding a migration

1. Create a new `.sql` file with a 4-digit numeric prefix that is strictly
   higher than any existing file and unique (no other file uses that prefix).
   As of this writing the highest is `0300`; use `0301` for the next migration.
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

### Follow-up — fresh-replay ordering (resolved)

The 0264–0293 renames changed where those files land in numeric apply order,
which broke **fresh replays** (CI's "Migration replay" job and brand-new
environments): several un-renamed migrations depended on objects that a
renamed file used to create earlier in the sequence, and two renamed files
recreated tables that `0220_drop_inbound_referral_subsystem` had already
dropped. Production was never affected (its ledger already records every
hash), but a fresh database could no longer be built from the tree.

Resolved with a second wave of hash-preserving renames:

| File (tag)                           | Moved     | Why                                                                |
| ------------------------------------ | --------- | ------------------------------------------------------------------ |
| `payer_profile_fill_and_reconcile`   | 0206→0295 | backfills `era_payer_id`, created in 0272 (old 0142)               |
| `more_pa_plausible_payers`           | 0209→0296 | same `era_payer_id` dependency                                     |
| `pa_dme_payers_completeness`         | 0210→0297 | same `era_payer_id` dependency                                     |
| `drop_health_connect_source`         | 0219→0298 | alters `patient_integration_snapshots`, created in 0269 (old 0065) |
| `inbound_fax_auto_file`              | 0258→0299 | FK to `signature_tracking`, created in 0292 (old 0254)             |
| `provider_portal_esign_tables`       | 0259→0300 | FK to `provider_portal_accounts`, created in 0291 (old 0253)       |
| `clinician_share_tokens`             | 0275→0206 | retired table must be created **before** 0220 drops it             |
| `inbound_webhooks_processing_status` | 0282→0209 | retired-table alter must run **before** 0220 drops it              |

Again file _content_ (and therefore each SHA256 hash) is unchanged — only
the filename prefixes moved, restoring a dependency-valid fresh-replay
order. Verified by a full 292-migration replay plus an idempotent re-run
on a clean Postgres 16.

## `meta/_journal.json`

This file is **frozen** at 53 entries (last: `0157_backfill_missing_inbound_tables`)
and is no longer appended to — new migrations are not journaled. The migrator
reads `_journal.json` only to recover the original `when` timestamp for
journaled files (used as the `created_at` value in the history table); it
applies all SQL files regardless of journal coverage.

**Do not hand-edit `meta/_journal.json`.**
