-- 0264_resupply_usage_compliance_flag — feature flag + CSR alert type
-- for the order-time continued-use (therapy adherence) soft gate.
--
-- Sibling to 0172 (too-soon/over-quantity entitlement guard) and 0185
-- (270/271 coverage guard). Therapy-cloud integrations already land
-- per-night usage in resupply.patient_therapy_nights, and the nightly
-- fleet scan raises adherence alerts — but nothing on the order-confirm
-- path consults that data. Medicare (and most payers) require evidence
-- of CONTINUED USE for resupply claims; auto-confirming a reorder for a
-- patient whose recent data shows they have effectively stopped using
-- the device risks a denial / claw-back weeks later.
--
-- This migration adds the two bits of stored state the wiring needs:
--
--   1. A new csr_compliance_alerts.alert_type value
--      ('resupply_usage_review') so a held reorder lands in the
--      existing CSR alert queue with its own filterable type (and the
--      "one open alert per (patient, alert_type)" partial unique index
--      collapses repeat blocks into a single open row per patient).
--
--   2. A feature flag ('resupply.usage_compliance_check') so the guard
--      can be turned on/off from the admin Control Center without a
--      deploy. SEEDED DISABLED: this is a behavior change on the
--      patient-facing confirm path, so production starts with it OFF
--      and ops flips it on deliberately. FAIL-OPEN by construction —
--      a patient with NO therapy data in the window (most patients;
--      cloud integrations are optional), a partial-data window, or any
--      lookup error always allows the confirmation through. Enabling
--      it can only ADD a CSR review step for patients whose own data
--      affirmatively shows non-use — it never strands a reorder on
--      missing data. (Dev/preview environments without a reachable
--      Supabase read every flag as enabled; fine given fail-open.)
--
-- Per ADR 003 — versioned hand-authored migration.

-- 1. Expand the alert_type enum (previously widened in
--    0065/0117/0133/0172/0185).
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
    'resupply_usage_review'
  ));
--> statement-breakpoint

-- 2. Seed the feature flag, DISABLED. ON CONFLICT keeps an operator's
--    later enable/disable choice intact on re-run.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('resupply.usage_compliance_check',
   false,
   'Continued-use check at resupply order-confirm time. When ON and the patient confirms a resupply, recent therapy data (patient_therapy_nights, last 30 days) showing the device is effectively unused raises a resupply_usage_review CSR alert and routes the order to the work queue instead of auto-shipping — protecting against continued-use claim denials. Fail-open: no data, sparse data, or any lookup error allows the order. When OFF, the check is skipped.',
   'Resupply')
ON CONFLICT (key) DO NOTHING;
