# `lib/resupply-db/drizzle/` — migration moratorium

> **Stop. Read this before adding a migration here.**

The directory name is **historical** — Drizzle has been fully retired
and new migrations are hand-written SQL applied by
`scripts/migrate.mjs` via raw `pg`. The directory and the on-DB
`drizzle.resupply_migrations` history table keep their names so the
existing production rows continue to gate new migrations cleanly; a
rename is tracked as a separate operational change.

The migration journal in this directory is currently out of sync
with the SQL files on disk. There are 73 `.sql` files but only 52 entries
in `meta/_journal.json`, and six prefixes are duplicated. Until that drift
is reconciled with production state, **no new migration may be added with
prefix `<= 0066`**, and the duplicate prefixes below must not be reused.

The full investigation, the production-state facts that need to be
collected first, and the coordinated rewrite procedure live in
[`docs/migration-state-investigation-2026-05-08.md`](../../../docs/migration-state-investigation-2026-05-08.md).

## What you need to know in 30 seconds

1. **`scripts/post-merge.sh` runs `migrate.mjs` at deploy time.** The
   migrator only applies files referenced by `meta/_journal.json`. Files
   in this directory that are not journaled are silently skipped at
   deploy time.
2. **The journal stops at `0049_physician_fax_outreach_status_pending_idx`.**
   Every SQL file from `0049_patient_documents.sql` through `0066_*` is
   present on disk but **not journaled** — meaning the schema state these
   files encode is _not_ applied by a fresh `migrate.mjs` run from this
   tree. (Production may or may not have applied them via a different
   path; that is one of the open questions.)
3. **Six prefixes collide:** `0016`, `0017`, `0049`, `0050`, `0052`,
   `0065`. Each pair was added independently and the canonical apply
   order can only be determined by inspecting prod's
   `drizzle.resupply_migrations.created_at`.

## The rule (enforced by `scripts/check-resupply-migration-prefix.sh`)

Any migration file _added_ under `lib/resupply-db/drizzle/` must have a
4-digit prefix **strictly greater than `0066`** (i.e. `0067` or higher).
The pre-commit hook fails the commit otherwise. This applies to _added_
files only — modifying existing migrations is already prohibited by
ADR 003 and caught in review.

This rule deliberately overshoots the duplicate-prefix set: capping at
`0066` covers every duplicate (`0016`, `0017`, `0049`, `0050`, `0052`,
`0065`) **and** the unjournaled range (`0049`–`0066`). A new migration
landing inside the unjournaled range — even on a unique prefix — would
become yet another file the deployed `migrate.mjs` silently ignores,
compounding the drift.

### Bypass

Genuine emergencies (e.g. a hotfix authored as part of the coordinated
rewrite itself) can bypass with:

```
SKIP_HOOKS=1 git commit ...
    (or)
git commit --no-verify ...
```

If you bypass, leave a comment in the commit body explaining why and
link to the rewrite ticket.

## Why we don't "just regenerate the journal"

It's tempting to hand-rewrite `_journal.json` from the current SQL
file set and ship it. **Don't.** The migrator
(`lib/resupply-db/scripts/migrate.mjs`) gates **only** on
`MAX(created_at)` in `drizzle.resupply_migrations` — it does not
compare hashes or tags, and will not "reject" a renamed migration
outright. The actual breakage modes:

- If production applied any of these files under different names
  (via a manual `psql` session or a previous tooling generation),
  rebuilding the journal locally will pick fresh `when` timestamps
  for every entry. The next deploy then sees those `when` values as
  strictly greater than production's `MAX(created_at)` and tries to
  re-apply every migration from the rebuild point forward —
  typically blowing up with `42P07 duplicate_object` from a repeated
  `CREATE TABLE patient_therapy_links`.
- If production hasn't redeployed since the journal was last in sync,
  we'd be rebuilding on a stale baseline; the next deploy attempts a
  from-scratch reapply that races with whatever else is in flight.

The repo cannot answer "which one"; that requires a read-only
`SELECT id, hash, created_at FROM
drizzle.resupply_migrations ORDER BY created_at` against production.
Only after that data is in hand can the journal be reconciled
in a way that leaves the deploy migrator a no-op.

## Duplicate-prefix inventory

| Prefix | File A                                              | File B                                               |
| ------ | --------------------------------------------------- | ---------------------------------------------------- |
| `0016` | `0016_shop_orders_email_tracking.sql`               | `0016_shop_returns.sql`                              |
| `0017` | `0017_csr_macros.sql`                               | `0017_shop_orders_customer_email.sql`                |
| `0049` | `0049_patient_documents.sql`                        | `0049_physician_fax_outreach_status_pending_idx.sql` |
| `0050` | \_two `0050__`files — see`ls drizzle/0050\__.sql`\_ |                                                      |
| `0052` | \_two `0052__`files — see`ls drizzle/0052\__.sql`\_ |                                                      |
| `0065` | \_two `0065__`files — see`ls drizzle/0065\__.sql`\_ |                                                      |

(Tabulated dynamically rather than statically pinned to keep the README
honest if a file is renamed during the eventual rewrite.)

## When the moratorium lifts

Once the production state is captured and the coordinated rename + UPDATE
script has shipped:

1. The duplicate-prefix list goes to zero.
2. `meta/_journal.json` matches the on-disk SQL files.
3. `scripts/check-resupply-migration-prefix.sh` is updated (or removed)
   so new migrations can be added in the normal `<next-prefix>` slot.

Until all three are true, this guardrail stays.
