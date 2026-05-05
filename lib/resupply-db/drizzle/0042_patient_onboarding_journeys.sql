-- patient_onboarding_journeys — first-90-day adherence-coaching
-- enrollment per patient (Phase B.1 / feature #17).
--
-- The CMS adherence threshold (4+ hours/night on 70% of nights in
-- the first 90 days) is missed by 40-70% of patients, and that's the
-- single biggest predictor of long-term reorder revenue. This table
-- backs the day-1 / day-7 / day-30 / day-90 check-in cadence that
-- /admin/onboarding/send-due fires via SendGrid + Twilio.
--
-- Lifecycle:
--   * `active`    — journey in flight; dispatcher considers this
--                   row when computing the next due check-in.
--   * `completed` — day-90 check-in fired and the journey is done.
--   * `paused`    — manual hold; dispatcher skips these rows. CSRs
--                   pause when a patient asks for fewer touches or
--                   when an issue needs to be resolved before more
--                   nudges go out.
--
-- One row per patient — re-enrolling a finished patient creates a
-- new row only if a CSR explicitly chooses to (the dispatcher never
-- re-creates rows on its own).
--
-- Audit verbs:
--   patient.onboarding.enroll       — admin enrolled
--   patient.onboarding.checkin_sent — dispatcher fired a nudge
--   patient.onboarding.complete     — day-90 transition
--   patient.onboarding.pause / resume
--
-- All audit envelopes are structural — patient_id, day_label, and
-- channel — never message content.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_onboarding_journeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- When the patient started therapy (proxy for "machine setup"
  -- date). The check-in cadence is computed off this anchor, not
  -- created_at, so a CSR enrolling a patient who started 3 days ago
  -- gets the day-7 nudge in 4 days rather than 7.
  "started_at" timestamp with time zone NOT NULL,
  -- Per-checkin send timestamps. Null until that step has fired.
  -- Once set, never cleared (we want the audit trail).
  "day1_sent_at" timestamp with time zone,
  "day7_sent_at" timestamp with time zone,
  "day30_sent_at" timestamp with time zone,
  "day90_sent_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'active',
  "enrolled_by_email" text NOT NULL,
  "enrolled_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_onboarding_journeys_status_enum"
    CHECK ("status" IN ('active','completed','paused'))
);

-- One active journey per patient — defense against double-enroll.
-- Partial unique index so completed/paused rows don't block a fresh
-- re-enrollment.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_onboarding_journeys_active_unique"
  ON "resupply"."patient_onboarding_journeys" ("patient_id")
  WHERE "status" = 'active';

-- Dispatcher scan: active rows ordered by started_at to compute
-- "what's the next due check-in across all enrolled patients".
CREATE INDEX IF NOT EXISTS "patient_onboarding_journeys_active_started_idx"
  ON "resupply"."patient_onboarding_journeys" ("started_at")
  WHERE "status" = 'active';
