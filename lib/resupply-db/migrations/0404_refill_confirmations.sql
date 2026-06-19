-- 0404_refill_confirmations — Medicare DMEPOS refill-affirmation capture
-- plus the CMS 14/10-day refill-window guard.
--
-- Why
-- ---
-- CMS Standard Documentation Requirements (PIM Ch. 5, "Refill
-- Requirements") and every major payer's DME contract require, for items
-- supplied on a recurring basis, that the supplier:
--
--   1. Contacts the beneficiary BEFORE dispensing a refill (no
--      auto-shipping on a fixed schedule), and
--   2. Documents that the beneficiary AFFIRMATIVELY CONFIRMED, at refill
--      time, that (a) they still need / are using the item, and (b) their
--      remaining supply is approaching exhaustion, and
--   3. Does not deliver/ship a refill earlier than the allowed window
--      (contact no sooner than 14 days, and ship no sooner than 10 days,
--      before the expected end of the current supply's usable life).
--
-- The platform already enforces (1) — nothing auto-ships; an order is
-- placed only on an affirmative SMS "YES", email-link click, or voice
-- confirmation. The interval/quantity entitlement guard (0171/0172)
-- already blocks shipping too soon. What was MISSING is a durable,
-- audit-grade record of the beneficiary's refill ATTESTATION (2) tied to
-- the episode that shipped, and an explicit representation of the CMS
-- refill window (3). This migration adds both.
--
-- Two pieces of stored state:
--
--   1. resupply.refill_confirmations — one row per confirmed resupply
--      episode capturing the beneficiary's attestation (continued use +
--      supply running low), the exact statement they agreed to (snapshot,
--      so a later copy edit never rewrites what they attested), the
--      channel, the requester relationship, the computed expected
--      depletion date, and the IP / user-agent of the click where we
--      have one. This is the document an auditor asks for.
--
--   2. Two feature flags:
--        resupply.refill_affirmation_capture — ON by default. Gates the
--          write of the attestation row. Seeded ON because capturing the
--          attestation is a compliance baseline, not a behavior change to
--          the patient-facing ship decision (the row is recorded AFTER a
--          successful confirm; a write failure never blocks the order).
--        resupply.refill_window_enforcement — OFF by default. When ON,
--          the order-confirm path additionally blocks a ship that would
--          land earlier than 10 days before the current supply's expected
--          depletion (CMS ship window), routing it to a CSR via a
--          resupply_refill_too_early alert. OFF by default because it is
--          a behavior change on the patient-facing confirm path; ops
--          flips it on deliberately. Fail-open on any lookup error.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."refill_confirmations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Denormalised org_id so the org-scoped Supabase facade can filter and
  -- tag rows without a join (every resupply table carries org_id).
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- One attestation per refill cycle (episode). UNIQUE so a duplicate
  -- confirm (patient clicks the email AND replies YES) records once.
  "episode_id" uuid NOT NULL
    REFERENCES "resupply"."episodes"("id") ON DELETE CASCADE,
  -- Soft reference — the prescription the episode shipped against, when
  -- known. Not an FK so prescription archival never orphans the proof.
  "prescription_id" uuid,
  -- The item SKU that shipped, and its resolved HCPCS family when we
  -- could map it (null when the SKU isn't in sku_hcpcs_map).
  "item_sku" text,
  "hcpcs_code" text,
  -- Channel the affirmation came in on.
  "channel" text NOT NULL
    CHECK ("channel" IN ('sms', 'email', 'voice', 'admin')),
  -- The two CMS attestations. Both default true because the confirm
  -- copy on every channel now states the attestation the patient is
  -- agreeing to ("confirm only if you still use your equipment and are
  -- running low"); an admin-placed order records the CSR's verbal
  -- confirmation.
  "affirm_continued_use" boolean NOT NULL DEFAULT true,
  "affirm_supply_low" boolean NOT NULL DEFAULT true,
  -- Snapshot of the exact statement the beneficiary agreed to, so a
  -- later copy edit never rewrites what they actually attested.
  "attestation_text" text NOT NULL,
  -- Who confirmed: the beneficiary or an authorized representative.
  "requested_by" text NOT NULL DEFAULT 'self'
    CHECK ("requested_by" IN (
      'self', 'spouse', 'guardian', 'power_of_attorney', 'caregiver',
      'authorized_rep', 'other'
    )),
  -- The computed expected end of the current supply's usable life at the
  -- time of the confirmation (last dispense + the HCPCS supply duration).
  -- Null on a first fill or when the SKU isn't mapped to a HCPCS family.
  "expected_depletion_on" date,
  -- Audit trail for the click that carried the attestation (email/web).
  -- SMS / voice / admin confirms have no UA; IP may still be present.
  "confirmer_ip" text,
  "confirmer_user_agent" text,
  "confirmed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("episode_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refill_confirmations_org_idx"
  ON "resupply"."refill_confirmations" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refill_confirmations_patient_idx"
  ON "resupply"."refill_confirmations" ("org_id", "patient_id", "confirmed_at" DESC);
--> statement-breakpoint

-- Expand the CSR alert_type enum (previously widened in
-- 0065/0117/0133/0172/0185/0300) with the refill-window block type.
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
    'resupply_refill_too_early'
  ));
--> statement-breakpoint

-- Seed feature flags. feature_flags is PER-TENANT since migration 0350
-- (PK (org_id, key)), so seed one row per organization and conflict on
-- (org_id, key). ON CONFLICT keeps an operator's later choice intact.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('resupply.refill_affirmation_capture',
   true,
   'Record the beneficiary''s Medicare/payer refill attestation (still using the device + current supply running low) as an audit-grade refill_confirmations row each time a resupply order is confirmed (SMS YES, email-link click, voice, or admin). Captured AFTER a successful confirm; a write failure never blocks the order. ON by default — this is a compliance documentation baseline, not a change to the ship decision. When OFF, no attestation row is written.',
   'Resupply'),
  ('resupply.refill_window_enforcement',
   false,
   'Enforce the CMS DMEPOS refill SHIP window at order-confirm time: block a resupply that would ship earlier than 10 days before the current supply''s expected depletion (last dispense + the HCPCS supply duration), routing it to a CSR via a resupply_refill_too_early alert instead of shipping. When OFF, the confirm-time interval/quantity entitlement guard is the only timing gate. Fail-open: a first fill, an unmapped SKU, or any lookup error allows the confirmation through.',
   'Resupply')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
