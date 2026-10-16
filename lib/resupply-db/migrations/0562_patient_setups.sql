-- One open new-CPAP setup per patient. This is a worklist row (owner,
-- reminder stamps), not a second order. Stage and blocker are computed
-- at read time from the chart, the fit request, the signature order,
-- and the first-night checklist.
CREATE TABLE IF NOT EXISTS resupply.patient_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  patient_id uuid NOT NULL REFERENCES resupply.patients(id),
  source text NOT NULL CHECK (source IN ('referral', 'fit_request', 'provider_referral', 'manual')),
  source_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  owner_user_id uuid,
  owner_email text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  blocker_cleared_notified_at timestamptz,
  signature_reminder_24_at timestamptz,
  signature_reminder_48_at timestamptz,
  setup_visit_offered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS patient_setups_one_open
  ON resupply.patient_setups (org_id, patient_id)
  WHERE status = 'open';
--> statement-breakpoint
ALTER TABLE resupply.patient_setups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON resupply.patient_setups FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON resupply.patient_setups TO service_role;
--> statement-breakpoint
-- Paperwork before ship for the Medicare DME MAC only. The global
-- orders.require_signed_paperwork flag stays off. Physician Part B
-- profiles are not DME and are left alone.
UPDATE resupply.payer_profiles
SET requires_signed_paperwork = true
WHERE slug = 'medicare_dme_noridian'
  AND requires_signed_paperwork = false;
--> statement-breakpoint
-- Chase unsigned signature links and ping the owner when a setup's
-- last blocker clears. Seeded ON: the messages are a second touch on
-- a link the tenant already sent, and the board is built either way.
INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('setups.chase',
   true,
   'Chase a new CPAP setup. ON: an unsigned signature link is reminded at 24 hours and again at 48 hours, and the owner gets a follow-up when the last blocker clears. OFF: those messages stop. The New setups board is still built either way.',
   'Operations')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
