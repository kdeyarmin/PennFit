-- 0369_inbound_fax_provider_id — vendor-neutral inbound-fax id (EXPAND).
--
-- `inbound_faxes.twilio_fax_sid` is a misnomer: inbound faxes moved from
-- Twilio to Telnyx (Twilio retired Programmable Fax), so the column stores
-- a Telnyx fax id and the name leaks a vendor we no longer use. This is the
-- EXPAND half of an expand/contract rename:
--
--   * adds `provider_fax_id` (vendor-neutral) and backfills it from
--     `twilio_fax_sid`,
--   * adds the UNIQUE idempotency index on `provider_fax_id` (the dedupe
--     key the inbound webhook relies on — Telnyx retries a fax.received and
--     every retry must be a no-op),
--   * LEAVES `twilio_fax_sid` exactly as it is (still NOT NULL, still
--     written by the app with the SAME value) so rolling back to the prior
--     release is safe.
--
-- After this release the app treats `provider_fax_id` as the canonical
-- dedupe key (insert + conflict lookup + reads) while continuing to
-- populate `twilio_fax_sid`. A later CONTRACT migration drops
-- `twilio_fax_sid` + its index once this release is deployed and verified
-- and the app's dual-write is removed (see PR notes / runbook).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "provider_fax_id" varchar(64);
--> statement-breakpoint

-- Backfill existing rows from the legacy column so the new dedupe key is
-- complete before the app starts reading it.
UPDATE "resupply"."inbound_faxes"
  SET "provider_fax_id" = "twilio_fax_sid"
  WHERE "provider_fax_id" IS NULL;
--> statement-breakpoint

-- Idempotency / dedupe key on the new column. Partial (excludes NULLs) so a
-- transient pre-backfill NULL never trips it; the app always writes a
-- non-NULL value, so a duplicate fax id still raises 23505 → no-op upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_faxes_provider_fax_id_unique"
  ON "resupply"."inbound_faxes" ("provider_fax_id")
  WHERE "provider_fax_id" IS NOT NULL;
