-- migrate: no-transaction
--
-- 0369_inbound_fax_provider_id — vendor-neutral inbound-fax id (EXPAND).
--
-- `inbound_faxes.twilio_fax_sid` is a misnomer: inbound faxes moved from
-- Twilio to Telnyx (Twilio retired Programmable Fax), so the column stores
-- a Telnyx fax id and the name leaks a vendor we no longer use. This is the
-- EXPAND half of a zero-downtime expand/contract rename, not an in-place
-- RENAME (the column is the inbound-fax idempotency key).
--
-- Runs OUTSIDE a transaction (`-- migrate: no-transaction`) so the unique
-- index is built CONCURRENTLY: `inbound_faxes` is on the inbound-fax
-- webhook hot path, and a plain index build's ACCESS EXCLUSIVE lock would
-- block inserts from the still-running PRIOR release during Railway's
-- preDeploy window (preDeploy migrates while the old release serves).
--
-- Cutover safety. That same preDeploy overlap means the old release — which
-- writes only `twilio_fax_sid` — can insert rows after this migration runs
-- but before the new release is live. A BEFORE INSERT/UPDATE trigger
-- mirrors `twilio_fax_sid` → `provider_fax_id`, so the new canonical column
-- is ALWAYS populated (never NULL) even for old-release writes; the unique
-- dedupe index and the new readers therefore stay correct across the
-- cutover. The one-time UPDATE backfills pre-existing rows; the trigger
-- covers the overlap window.
--
-- The CONTRACT phase drops the trigger + function together with
-- `twilio_fax_sid` (see docs/runbooks/fax-column-rename.md).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "provider_fax_id" varchar(64);
--> statement-breakpoint

-- One-time backfill of pre-existing rows from the legacy column.
UPDATE "resupply"."inbound_faxes"
  SET "provider_fax_id" = "twilio_fax_sid"
  WHERE "provider_fax_id" IS NULL;
--> statement-breakpoint

-- Keep provider_fax_id populated for writes from the PRIOR release (which
-- only sets twilio_fax_sid) during the deploy overlap. No-op once the new
-- release sets provider_fax_id explicitly.
CREATE OR REPLACE FUNCTION "resupply"."inbound_faxes_sync_provider_fax_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."provider_fax_id" IS NULL THEN
    NEW."provider_fax_id" := NEW."twilio_fax_sid";
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "inbound_faxes_sync_provider_fax_id_trg"
  ON "resupply"."inbound_faxes";
--> statement-breakpoint

CREATE TRIGGER "inbound_faxes_sync_provider_fax_id_trg"
  BEFORE INSERT OR UPDATE ON "resupply"."inbound_faxes"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."inbound_faxes_sync_provider_fax_id"();
--> statement-breakpoint

-- Idempotency / dedupe key on the new column, built CONCURRENTLY (see the
-- no-transaction note above). Partial (excludes NULLs); the app + trigger
-- always write a non-NULL value, so a duplicate fax id still raises 23505 →
-- no-op upsert.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "inbound_faxes_provider_fax_id_unique"
  ON "resupply"."inbound_faxes" ("provider_fax_id")
  WHERE "provider_fax_id" IS NOT NULL;
