-- Tie a new-CPAP setup to the signature order it is chasing, and
-- remember which link the 24h/48h stamps belong to. Shipment and
-- onboarding progress are stored separately so a failed enroll can
-- be retried without sending a second follow-up.
ALTER TABLE resupply.patient_setups
  ADD COLUMN IF NOT EXISTS csr_order_request_id uuid,
  ADD COLUMN IF NOT EXISTS reminder_order_id uuid,
  ADD COLUMN IF NOT EXISTS reminder_link_version integer,
  ADD COLUMN IF NOT EXISTS followup_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_enrolled_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_setups_open_order
  ON resupply.patient_setups (org_id, opened_at, id)
  WHERE status = 'open';
