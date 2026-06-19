-- 0370_inbound_fax_twilio_sid_nullable — CONTRACT step 2a of the
-- twilio_fax_sid → provider_fax_id rename (see migration 0369 and
-- docs/runbooks/fax-column-rename.md).
--
-- Relaxes the legacy column so the app can STOP writing it. After this:
--   * the new release inserts only `provider_fax_id` (omits twilio_fax_sid),
--     which is fine now that the column is nullable;
--   * during Railway's preDeploy overlap the PRIOR (0369) release still
--     dual-writes a non-NULL twilio_fax_sid, which is also fine.
-- The legacy unique index treats NULLs as distinct, so multiple
-- twilio_fax_sid-NULL rows do not collide. The column, its index, and the
-- 0369 sync trigger/function are all removed in step 2b.
--
-- ⚠️  Run ONLY after 0369 is live in production AND verified — every row has
-- a non-NULL provider_fax_id and no rollback to a pre-0369 release is
-- contemplated:
--     SELECT count(*) FROM resupply.inbound_faxes WHERE provider_fax_id IS NULL;
--     -- expect 0
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."inbound_faxes"
  ALTER COLUMN "twilio_fax_sid" DROP NOT NULL;
