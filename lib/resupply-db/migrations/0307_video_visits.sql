-- 0307_video_visits — telehealth video visits.
--
-- Staff (an RT or CSR) starts a browser-to-browser video call with a
-- patient for equipment setups, mask troubleshooting, or follow-ups.
-- The patient joins from an HMAC-signed link (same RESUPPLY_LINK_HMAC_KEY
-- primitive as patient packets); media flows peer-to-peer over WebRTC —
-- the server only relays signaling and NEVER sees or stores audio/video.
--
-- Design notes
-- ------------
--   * `link_version` mirrors patient_packets.link_version: bumping it
--     invalidates every outstanding patient join link (cancel does this).
--   * `created_by_admin_user_id` / `created_by_email` are free-form text
--     (no FK) so the row survives admin-account deletion, matching the
--     feature_flags.updated_by_user_id posture.
--   * Lifecycle: scheduled → in_progress (first staff WS join) →
--     completed (staff ends the call, or explicit complete action).
--     cancelled is terminal and revokes the link.
--   * No PHI beyond the patient FK: notes are staff-authored context
--     ("walk through humidifier setup"), never clinical documentation —
--     clinical notes belong in clinical_encounters.

CREATE TABLE IF NOT EXISTS resupply.video_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES resupply.patients(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'setup'
    CHECK (purpose IN ('setup', 'troubleshooting', 'follow_up', 'other')),
  notes text,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_at timestamptz,
  created_by_admin_user_id text,
  created_by_email text,
  link_version integer NOT NULL DEFAULT 1,
  invite_channel text
    CHECK (invite_channel IN ('sms', 'email', 'none')),
  invite_delivered boolean,
  staff_joined_at timestamptz,
  patient_joined_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_visits_patient_created_idx
  ON resupply.video_visits (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS video_visits_status_scheduled_idx
  ON resupply.video_visits (status, scheduled_at);

-- RLS — match the deny-all posture established in 0169/0170.
-- service_role (the only runtime data path) bypasses RLS; enabling it
-- with no policy makes the table deny-all to anon/authenticated, the
-- intended end-state for a service-role-only schema. 0170's catalog
-- loop already ran, so a new table must enable it here.
ALTER TABLE resupply.video_visits ENABLE ROW LEVEL SECURITY;

-- Feature flag: seeded ON (the table's default-enabled posture). The
-- create / invite / join routes and the signaling WebSocket all consult
-- it, so flipping it OFF stops new visits and dead-ends join links
-- without a deploy.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'telehealth.video',
  true,
  'Telehealth video visits — staff-initiated browser video calls with patients for setups, troubleshooting, and follow-ups. Disabling blocks new visit creation and dead-ends outstanding join links.',
  'Voice & AI'
)
ON CONFLICT (key) DO NOTHING;
