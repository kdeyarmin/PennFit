-- 0172_resupply_entitlement_enforcement — feature flag + CSR alert type
-- for the order-time "too-soon / over-quantity" reorder guard.
--
-- Builds on 0171 (hcpcs_codes + sku_hcpcs_map + the pure
-- resolveResupplyEntitlement domain fn). This migration adds the two
-- bits of stored state the enforcement wiring needs:
--
--   1. A feature flag (`resupply.entitlement_enforcement`) so the guard
--      can be turned on/off from the admin Control Center without a
--      deploy. SEEDED DISABLED: enforcement is a behavior change on the
--      patient-facing confirm path, so production starts with it OFF
--      and ops flips it on deliberately. (Dev/preview environments
--      without a reachable Supabase read every flag as enabled — that's
--      fine because the enforcement code fails OPEN on any lookup error,
--      so it never blocks a confirm it can't fully evaluate.)
--
--   2. A new csr_compliance_alerts.alert_type value
--      ('resupply_too_soon') so a blocked reorder lands in the existing
--      CSR alert queue with its own filterable type (and the existing
--      "one open alert per (patient, alert_type)" partial unique index
--      collapses repeat blocks into a single open row per patient).
--
-- Per ADR 003 — versioned hand-authored migration.

-- 1. Expand the alert_type enum (previously widened in 0065/0117/0133).
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
    'resupply_too_soon'
  ));
--> statement-breakpoint

-- 2. Seed the feature flag, DISABLED. ON CONFLICT keeps an
--    operator's later enable/disable choice intact on re-run.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('resupply.entitlement_enforcement',
   false,
   'Block a resupply confirmation when the item is not yet payable under the Medicare/payer replacement schedule (too soon since last dispense, or over the per-period quantity cap). When ON, a blocked reorder is routed to a CSR via a resupply_too_soon alert instead of shipping. When OFF, confirmations ship as before. Fails open on any eligibility-lookup error.',
   'Resupply')
ON CONFLICT (key) DO NOTHING;
