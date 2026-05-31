-- 0185_eligibility_enforcement_flag — feature flag + CSR alert type for
-- the order-time coverage guard that consults the cached 270/271 (#2).
--
-- Sibling to 0172 (the too-soon/over-quantity entitlement guard). The
-- 270→271 round-trip already lands a parsed coverage row in
-- resupply.eligibility_checks (worker/jobs/office-ally-inbound-poll.ts
-- dispatch271). Until now nothing consulted that result before creating
-- a fulfillment, so a patient could confirm a resupply (SMS YES / email
-- link) on coverage that is inactive or requires prior auth — the claim
-- then denies weeks later and the patient gets a surprise bill.
--
-- This migration adds the two bits of stored state the wiring needs:
--
--   1. A new csr_compliance_alerts.alert_type value
--      ('resupply_coverage_blocked') so a held reorder lands in the
--      existing CSR alert queue with its own filterable type (and the
--      "one open alert per (patient, alert_type)" partial unique index
--      collapses repeat blocks into a single open row per patient).
--
--   2. A feature flag ('resupply.eligibility_enforcement') so the guard
--      can be turned on/off from the admin Control Center without a
--      deploy. SEEDED DISABLED: the guard is only meaningful once 270s
--      are being run for the population (today they're admin-triggered,
--      so most patients have no parsed result and the guard fails open /
--      no-ops). Production starts with it OFF and ops flips it on once
--      eligibility data is flowing. FAIL-OPEN by construction — a
--      missing/stale result, an unmapped coverage, or any lookup error
--      always allows the confirmation through, so enabling it can only
--      ADD a CSR review step, never strand a legitimate reorder.
--      (Dev/preview environments without a reachable Supabase read every
--      flag as enabled; that's fine given the fail-open posture.)
--
-- Per ADR 003 — versioned hand-authored migration.

-- 1. Expand the alert_type enum (previously widened in 0065/0117/0133/0172).
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
    'resupply_coverage_blocked'
  ));
--> statement-breakpoint

-- 2. Seed the feature flag, DISABLED. ON CONFLICT keeps an operator's
--    later enable/disable choice intact on re-run.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('resupply.eligibility_enforcement',
   false,
   'Consult the cached 270/271 eligibility result at order-confirm time. When ON and the patient confirms a resupply, an explicitly inactive plan or a prior-auth-required flag raises a resupply_coverage_blocked CSR alert and routes the order to the work queue instead of auto-shipping. Fail-open: no/stale result allows the order. When OFF, the coverage check is skipped (cadence/quantity entitlement is gated separately by resupply.entitlement_enforcement).',
   'Resupply')
ON CONFLICT (key) DO NOTHING;
