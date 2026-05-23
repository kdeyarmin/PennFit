-- inbound_webhooks: add 'processing' status + lease column for atomic
-- claim/lease/recovery on the inbound-webhook dispatcher.
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
-- The atomic-claim pattern webhook-dispatcher.ts and
-- inbound-referral-status-outbound.ts already use:
--   UPDATE ... SET status = 'processing', processing_started_at = now()
--   WHERE id IN (...) AND status IN ('received','processing_failed')
--   RETURNING ...
-- and only process the returned winners. That needs both a
-- 'processing' state in the enum AND a way to revive rows whose
-- dispatcher crashed before flipping the row back out of
-- 'processing'. The lease column lets the dispatcher reclaim stuck
-- rows older than its threshold (currently 5 minutes; see the
-- recovery sweep at the top of runInboundWebhookDispatcher).
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

ALTER TABLE "resupply"."inbound_webhooks"
  ADD COLUMN IF NOT EXISTS "processing_started_at"
    timestamp with time zone;

DROP INDEX IF EXISTS "resupply"."inbound_webhooks_pending_idx";

-- Pending index covers all three actionable states. 'received' and
-- 'processing_failed' are the normal claim targets; 'processing' is
-- only there so the lease-recovery sweep can find rows whose
-- dispatcher crashed mid-row — without it, stuck rows would silently
-- disappear from the index-driven scan and never re-enter the loop.
CREATE INDEX IF NOT EXISTS "inbound_webhooks_pending_idx"
  ON "resupply"."inbound_webhooks" ("status", "received_at")
  WHERE "status" IN ('received', 'processing_failed', 'processing');
