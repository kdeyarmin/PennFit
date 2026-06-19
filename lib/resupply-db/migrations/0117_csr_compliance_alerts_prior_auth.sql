-- 0117_csr_compliance_alerts_prior_auth — extend the CSR alert type
-- enum to cover prior-authorization lifecycle events.
--
-- Why
-- ---
-- The /patients/:id/prior-authorizations route comments state that
-- "expired is set by a daily sweep, not by the API" — but no such
-- sweep existed and approved PAs accumulated indefinitely past their
-- approved_through date. The PA expiry sweep worker flips
-- status='approved' → 'expired' on the day after approved_through,
-- and queues a heads-up CSR alert at T-30 / T-14 / T-7 / T+1 so the
-- billing team can chase a renewal before claims start denying.
--
-- The existing csr_compliance_alerts.alert_type CHECK enum only
-- allows 'low_usage', 'no_response', 'send_failure', 'manual'. We
-- add two new values:
--
--   'prior_auth_expiring'  — heads-up window before approved_through.
--   'prior_auth_expired'   — PA has just been flipped to expired.
--
-- Why two types and not one with metric_snapshot variants: the
-- triage paths are different (expiring → renew before expiry,
-- expired → block dispense and renew), and the CSR queue filters
-- by alert_type so muddying them costs more than the enum split.
--
-- Per ADR 003 — versioned hand-authored migration.

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
    'prior_auth_expired'
  ));
