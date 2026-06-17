-- 0371_inbound_fax_drop_twilio_sid — CONTRACT step 2b (final) of the
-- twilio_fax_sid → provider_fax_id rename (see migrations 0369 + 0370 and
-- docs/runbooks/fax-column-rename.md).
--
-- Removes the legacy column for good. Order matters: the 0369 sync
-- trigger/function reference twilio_fax_sid, so they must go BEFORE the
-- column. provider_fax_id (with its own unique index from 0369) has been
-- the sole idempotency key since 0369, and step 2a stopped all writes to
-- twilio_fax_sid, so dropping it is now safe.
--
-- ⚠️  Run ONLY after step 2a (migration 0370 + the app release that stopped
-- writing twilio_fax_sid) is live in production. Railway runs this migration
-- during preDeploy WHILE the previous release is still serving traffic, so
-- the bar is that NO running release writes, reads, or otherwise references
-- the column — any lingering SELECT/INSERT that names it starts erroring the
-- instant this runs. (As of step 2a no app code references twilio_fax_sid;
-- all readers moved to provider_fax_id back in the 0369 EXPAND phase.)
-- Confirm the new key is complete first:
--     SELECT count(*) FROM resupply.inbound_faxes WHERE provider_fax_id IS NULL;
--     -- expect 0
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

DROP TRIGGER IF EXISTS "inbound_faxes_sync_provider_fax_id_trg"
  ON "resupply"."inbound_faxes";
--> statement-breakpoint

DROP FUNCTION IF EXISTS "resupply"."inbound_faxes_sync_provider_fax_id"();
--> statement-breakpoint

DROP INDEX IF EXISTS "resupply"."inbound_faxes_twilio_fax_sid_unique";
--> statement-breakpoint

ALTER TABLE "resupply"."inbound_faxes"
  DROP COLUMN IF EXISTS "twilio_fax_sid";
