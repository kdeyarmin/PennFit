-- 0308_video_visits_guests — guest (no-chart) telehealth video visits.
--
-- Staff need to start a video visit with someone who isn't a patient
-- yet — a prospect mid-intake, a family member helping with a setup, a
-- referral who hasn't been imported from PacWare. Relax the
-- patient FK to nullable and carry the minimal contact info needed to
-- deliver the invite. A visit must have SOME subject: either a patient
-- row or a guest name.
--
-- PHI posture: guest_name/email/phone are the same sensitivity class
-- as the patients columns; the table already carries deny-all RLS
-- (0307) and the service-role client is the only runtime path.

ALTER TABLE resupply.video_visits
  ALTER COLUMN patient_id DROP NOT NULL;

ALTER TABLE resupply.video_visits
  ADD COLUMN IF NOT EXISTS guest_name text,
  ADD COLUMN IF NOT EXISTS guest_email text,
  ADD COLUMN IF NOT EXISTS guest_phone_e164 text;

-- Every existing row has a patient_id, so validating the constraint
-- against current data is free.
ALTER TABLE resupply.video_visits
  ADD CONSTRAINT video_visits_subject_check
  CHECK (patient_id IS NOT NULL OR guest_name IS NOT NULL);
