-- 0505_address_change_pending_alert — extend the CSR alert type enum to
-- cover a pending patient address change.
--
-- Why
-- ---
-- When a patient asked to change their shipping address, the only thing
-- that happened was the conversation flipping to 'awaiting_admin'. If
-- they had already clicked Confirm on the same reminder, a fulfillment
-- row was sitting at status='queued' pointing at the OLD address, and
-- nothing held it. The signed links also stay valid regardless of
-- conversation status, so the reverse order (edit, then confirm) shipped
-- to the stale address too.
--
-- The patient-facing copy had been telling them "nothing ships until
-- then", which the code did not back. Rather than delete the promise, we
-- make it true: an address-change request now holds the patient's
-- not-yet-shipped fulfillments and opens a CSR alert, and a confirm is
-- refused while that alert is open. Resolving the alert releases the
-- hold, so the existing CSR queue is the release valve — no new
-- workflow, and no way for an order to get stranded.
--
-- This migration only widens the alert_type CHECK enum; the hold itself
-- lives in fulfillments.status, which is a plain text column with no
-- constraint, so 'on_hold' needs no schema change.
--
-- The value list below is the one established by 0404 plus the new
-- 'address_change_pending'. Per ADR 003 — versioned hand-authored
-- migration. Idempotent: DROP ... IF EXISTS before ADD, and every
-- pre-existing row already satisfies the widened CHECK.

ALTER TABLE "resupply"."csr_compliance_alerts"
  DROP CONSTRAINT IF EXISTS "csr_compliance_alerts_alert_type_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."csr_compliance_alerts"
  ADD CONSTRAINT "csr_compliance_alerts_alert_type_enum"
  CHECK ("alert_type" IN (
    'low_usage',
    'no_response',
    'send_failure',
    'manual',
    'prior_auth_expiring',
    'prior_auth_expired',
    'pa_mco_sla_at_risk',
    'pa_mco_sla_missed',
    'resupply_too_soon',
    'resupply_coverage_blocked',
    'resupply_usage_review',
    'resupply_refill_too_early',
    'address_change_pending'
  ));
--> statement-breakpoint

-- Partial index so the confirm-time guard ("is an address change pending
-- for this patient?") is an index probe rather than a scan. It runs on
-- every patient confirm, which is the hot path for the whole resupply
-- flow.
CREATE INDEX IF NOT EXISTS "csr_compliance_alerts_open_address_change_idx"
  ON "resupply"."csr_compliance_alerts" ("patient_id")
  WHERE "status" = 'open' AND "alert_type" = 'address_change_pending';
--> statement-breakpoint

-- Same reasoning for the hold/release sweep, which looks up a patient's
-- not-yet-shipped fulfillments by status.
CREATE INDEX IF NOT EXISTS "fulfillments_patient_status_idx"
  ON "resupply"."fulfillments" ("patient_id", "status");
