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
- adds the unique idempotency index `inbound_faxes_provider_fax_id_unique`,
- leaves `twilio_fax_sid` untouched (still `NOT NULL`, still written).

App changes in the same release:

- `ingest-inbound.ts` **dual-writes** both columns (same value) and uses
  `provider_fax_id` as the canonical insert + conflict-lookup key.
- All readers (`inbound-faxes.ts`, `today.ts`) select `provider_fax_id`;
  the API/UI field is `providerFaxId` / `provider_fax_id`.

After this release the app reads only `provider_fax_id`; `twilio_fax_sid`
is kept current **solely** so a rollback to the prior release is safe.

## Phase 2 — CONTRACT (do later, in a SEPARATE deploy)

Only after Phase 1 has been deployed to production and verified (every new
row has a non-NULL `provider_fax_id`; no rollback to a pre-0369 release is
contemplated):

1. Remove the legacy write + column from the app first:
   - drop `twilio_fax_sid: input.telnyxFaxId,` from the `ingest-inbound.ts`
     insert (leave `provider_fax_id`),
   - remove `twilio_fax_sid` from `inbound_faxes.Row` in
     `lib/resupply-db/src/supabase-types.ts`.
2. Ship a contract migration (next free prefix at that time), e.g.:

   ```sql
   -- 0XXX_inbound_fax_drop_twilio_fax_sid — CONTRACT half of the
   -- twilio_fax_sid → provider_fax_id rename. Run ONLY after 0369 is live
   -- and verified, and after the app has stopped writing twilio_fax_sid.
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
