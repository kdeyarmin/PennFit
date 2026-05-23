-- inbound_webhooks: add 'processing' status for atomic claim/lease.
--
-- Why
-- ---
-- The inbound-webhook dispatcher (artifacts/resupply-api/src/worker/
-- jobs/inbound-webhook-dispatch.ts) runs every 60s. A row whose
-- dispatcher takes >60s (any EHR FHIR write that round-trips HTTP)
-- would be picked up by the next tick and processed twice — which,
-- for the Parachute dispatcher, materialises a duplicate
-- patient_referral row, and for FHIR materialises a duplicate
-- ServiceRequest.
--
-- The fix is the same atomic-claim pattern webhook-dispatcher.ts and
-- inbound-referral-status-outbound.ts already use:
--   UPDATE ... SET status = 'processing' WHERE id IN (...) AND status
--   IN ('received','processing_failed') RETURNING ...
-- and only process the returned winners. That needs a 'processing'
-- state in the enum.
--
-- A stuck row (worker crashed mid-process) sits in 'processing'
-- without a lease timeout in this initial cut; the partial index
-- below covers `('received','processing_failed','processing')` so
-- a follow-up migration adding `processing_lease_until` can revive
-- abandoned rows without another schema change.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."inbound_webhooks"
  DROP CONSTRAINT IF EXISTS "inbound_webhooks_status_enum";

ALTER TABLE "resupply"."inbound_webhooks"
  ADD CONSTRAINT "inbound_webhooks_status_enum"
    CHECK ("status" IN (
      'received', 'processing', 'processed', 'duplicate',
      'processing_failed', 'rejected'
    ));

DROP INDEX IF EXISTS "resupply"."inbound_webhooks_pending_idx";

CREATE INDEX IF NOT EXISTS "inbound_webhooks_pending_idx"
  ON "resupply"."inbound_webhooks" ("status", "received_at")
  WHERE "status" IN ('received', 'processing_failed');
