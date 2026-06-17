# Runbook: renaming `inbound_faxes.twilio_fax_sid` → `provider_fax_id`

`inbound_faxes.twilio_fax_sid` is a misnomer — inbound faxes moved off
Twilio (which retired Programmable Fax) onto Telnyx, so the column holds a
Telnyx fax id and the name leaks a vendor we no longer use. Because the
column is the **inbound-fax idempotency key** (Telnyx retries a
`fax.received` and every retry must be a no-op), it is renamed with a
zero-downtime **expand / contract** sequence, not an in-place `RENAME`.

## Phase 1 — EXPAND (shipped: migration 0369)

Migration `0369_inbound_fax_provider_id.sql`:

- adds `provider_fax_id` and backfills it from `twilio_fax_sid`,
- adds a BEFORE INSERT/UPDATE trigger
  (`inbound_faxes_sync_provider_fax_id_trg`) that mirrors
  `twilio_fax_sid` → `provider_fax_id` when the latter is NULL, so writes
  from the **prior release** (which only sets `twilio_fax_sid`) during the
  preDeploy overlap still populate the new column,
- adds the unique idempotency index `inbound_faxes_provider_fax_id_unique`,
  built **CONCURRENTLY** (the file is `-- migrate: no-transaction`) so the
  build doesn't lock the inbound-fax hot path,
- leaves `twilio_fax_sid` untouched (still `NOT NULL`, still written).

App changes in the same release:

- `ingest-inbound.ts` **dual-writes** both columns (same value), uses
  `provider_fax_id` as the canonical insert + conflict key, and the 23505
  conflict lookup matches **either** column (`.or(...)`) — defense in depth
  for the micro-window before the trigger exists.
- All readers (`inbound-faxes.ts`, `today.ts`) select `provider_fax_id`;
  the API/UI field is `providerFaxId` / `provider_fax_id`.

After this release the app reads only `provider_fax_id`; the trigger +
`twilio_fax_sid` are kept **solely** so a rollback to the prior release is
safe.

## Phase 2 — CONTRACT (do later, in TWO separate deploys)

`twilio_fax_sid` is still `NOT NULL` after Phase 1, and Railway's
`preDeployCommand` runs migrations **while the previous release is still
serving traffic**. That forces the contract into two ordered deploys —
collapsing them (or stopping the legacy write before the column is
nullable, or dropping the column in the same deploy that stops writing it)
makes the previous release's inserts fail mid-cutover.

Only start after Phase 1 is deployed and verified (every row has a non-NULL
`provider_fax_id`; no rollback to a pre-0369 release is contemplated):

### Deploy 2a — make the legacy column optional, stop writing it

Ship **together** (the migration only relaxes a constraint, so the still-
running Phase 1 release — which writes a non-NULL value — keeps working,
and the new release — which omits it — works because the column is now
nullable):

1. Migration (next free prefix), making the legacy column writable-by-absence:

   ```sql
   ALTER TABLE "resupply"."inbound_faxes"
     ALTER COLUMN "twilio_fax_sid" DROP NOT NULL;
   ```

2. App: drop `twilio_fax_sid: input.telnyxFaxId,` from the
   `ingest-inbound.ts` insert (leave `provider_fax_id`). Keep the dual-key
   `.or(...)` conflict lookup for now (it is harmless and still covers any
   pre-2a rows).

### Deploy 2b — drop the column (a later deploy)

Once 2a is live and no release writes `twilio_fax_sid` any more:

1. Remove `twilio_fax_sid` from `inbound_faxes.Row` in
   `lib/resupply-db/src/supabase-types.ts`, and simplify the
   `ingest-inbound.ts` conflict lookup back to `provider_fax_id` only.
2. Migration — drop the sync trigger + function (they reference the legacy
   column) before dropping the column itself:

   ```sql
   -- CONTRACT: run ONLY after 2a is live and no release writes the column.
   DROP TRIGGER IF EXISTS "inbound_faxes_sync_provider_fax_id_trg"
     ON "resupply"."inbound_faxes";
   --> statement-breakpoint
   DROP FUNCTION IF EXISTS "resupply"."inbound_faxes_sync_provider_fax_id"();
   --> statement-breakpoint
   DROP INDEX IF EXISTS "resupply"."inbound_faxes_twilio_fax_sid_unique";
   --> statement-breakpoint
   ALTER TABLE "resupply"."inbound_faxes"
     DROP COLUMN IF EXISTS "twilio_fax_sid";
   ```

Verify the backfill is complete before dropping:

```sql
SELECT count(*) FROM resupply.inbound_faxes WHERE provider_fax_id IS NULL;
-- expect 0
```
