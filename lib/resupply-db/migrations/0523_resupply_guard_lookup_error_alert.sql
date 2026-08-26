-- 0523_resupply_guard_lookup_error_alert — extend the CSR alert type
-- enum for fail-closed order-confirm guard lookup failures.
--
-- Why
-- ---
-- When an enforcement flag is ON (entitlement / eligibility / usage /
-- refill-window) and the underlying lookup throws or returns a DB
-- error, placeResupplyOrderForConversation now holds the confirm
-- (fail-closed) instead of shipping. Staff need a queue row that is
-- distinct from a true payer denial (resupply_too_soon /
-- resupply_coverage_blocked / …) so they know to re-run the check,
-- not to overturn an adjudicated answer.
--
-- This migration only widens the alert_type CHECK enum. The hold
-- itself is the episode staying in outreach_pending /
-- awaiting_response — no schema change there.
--
-- The value list below is the one established by 0505 plus the new
-- 'resupply_guard_lookup_error'. Per ADR 003 — versioned hand-authored
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
    'address_change_pending',
    'resupply_guard_lookup_error'
  ));
--> statement-breakpoint
