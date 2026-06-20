-- Migration 0401 — Patient SMS-marketing consent
--
-- Adds three columns to resupply.patients:
--
--   sms_marketing_consent        boolean NOT NULL DEFAULT false
--     The consent bit. false = no consent on file (default, opt-in model
--     required by TCPA). true = express written consent recorded.
--
--   sms_marketing_consent_at     timestamptz
--     When consent was given (or explicitly withdrawn). NULL when the
--     column has never been set (legacy rows before this migration land
--     at the default false with no timestamp).
--
--   sms_marketing_consent_source text CHECK (... IN ('staff','portal'))
--     Who recorded the consent:
--       'staff'  — admin toggled it via the patient settings panel
--       'portal' — patient self-served via the patient portal

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "sms_marketing_consent" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "sms_marketing_consent_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "sms_marketing_consent_source" text
    CHECK ("sms_marketing_consent_source" IN ('staff', 'portal'));
--> statement-breakpoint

-- Grant SELECT/UPDATE on the new columns to the Supabase data-API roles
-- (anon and authenticated read the RLS-scoped view; service_role writes).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT (sms_marketing_consent, sms_marketing_consent_at, sms_marketing_consent_source)
      ON "resupply"."patients" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT (sms_marketing_consent, sms_marketing_consent_at, sms_marketing_consent_source)
      ON "resupply"."patients" TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, UPDATE (sms_marketing_consent, sms_marketing_consent_at, sms_marketing_consent_source)
      ON "resupply"."patients" TO service_role;
  END IF;
END
$$;
