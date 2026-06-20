-- Patient check-in reminder expansion + CSR compliance alerts.
--
-- Builds on migration 0042 (patient_onboarding_journeys). The original
-- cadence — day 1 / 7 / 30 / 90 — was email-only and missed the two
-- inflection points where most patients drop out: day 3 (peak mask
-- discomfort, when first-week dropout spikes) and day 60 (when the
-- post-acclimation slump is hardest to recover from). This migration:
--
--   1. Adds `day3_sent_at` and `day60_sent_at` columns to track the
--      new cadence anchors. The legacy `day1_sent_at` column is kept
--      so existing in-flight journeys preserve their audit history;
--      new code does not write to it.
--
--   2. Adds `patient_checkin_attempts` — a per-(journey, day, channel)
--      log of every email / SMS / automated-voice send (or skip /
--      vendor failure). The journey row's `dayN_sent_at` is the
--      "first successful delivery" timestamp; this table is the
--      detailed audit + retry surface CSRs use to diagnose "why
--      didn't this patient hear from us?".
--
--   3. Adds `csr_compliance_alerts` — the at-risk queue surfaced in
--      the admin dashboard. Rows are auto-created by the daily
--      compliance scanner (low-usage detection from
--      patient_therapy_nights, no-response after a check-in send)
--      and resolved manually by a CSR.
--
-- PHI / log posture: alert rows store ONLY structural fields
-- (patient_id, alert_type, severity, computed metric snapshot). Free-
-- text body is bounded to a one-line CSR-facing summary; no clinical
-- detail beyond the metric that triggered the alert.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ───────────────────────────────────────────────────────────────────
-- 1. Cadence expansion on patient_onboarding_journeys.
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE "resupply"."patient_onboarding_journeys"
  ADD COLUMN IF NOT EXISTS "day3_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "day60_sent_at" timestamp with time zone;

-- ───────────────────────────────────────────────────────────────────
-- 2. patient_checkin_attempts — per-channel attempt log.
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "resupply"."patient_checkin_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "journey_id" uuid NOT NULL
    REFERENCES "resupply"."patient_onboarding_journeys"("id") ON DELETE CASCADE,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- One of: 'day3', 'day7', 'day30', 'day60', 'day90'. We store as
  -- text rather than an enum so a future cadence tweak is a one-line
  -- change rather than a migration. The check constraint pins the
  -- current set.
  "day_label" text NOT NULL,
  -- One of: 'email', 'sms', 'voice'.
  "channel" text NOT NULL,
  -- One of:
  --   'sent'                  — vendor accepted the send
  --   'skipped_no_contact'    — patient lacks the channel's contact field
  --   'skipped_not_configured' — vendor (SendGrid/Twilio) not configured
  --   'vendor_error'          — vendor returned an error
  "outcome" text NOT NULL,
  -- Vendor-side ref so ops can reconcile (SendGrid messageId, Twilio
  -- messageSid / callSid). Null for skip outcomes.
  "vendor_ref" text,
  -- Short error code for vendor_error rows (e.g. 'twilio:21610' for
  -- "STOP'd recipient"). Bounded text — we never stash full vendor
  -- response bodies here.
  "error_code" text,
  "attempted_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_checkin_attempts_day_label_enum"
    CHECK ("day_label" IN ('day3','day7','day30','day60','day90')),
  CONSTRAINT "patient_checkin_attempts_channel_enum"
    CHECK ("channel" IN ('email','sms','voice')),
  CONSTRAINT "patient_checkin_attempts_outcome_enum"
    CHECK ("outcome" IN ('sent','skipped_no_contact','skipped_not_configured','vendor_error'))
);

-- "What attempts have we made for journey X" — the admin detail panel
-- reads by journey_id ordered by attempted_at desc.
CREATE INDEX IF NOT EXISTS "patient_checkin_attempts_journey_idx"
  ON "resupply"."patient_checkin_attempts" ("journey_id", "attempted_at" DESC);

-- "Has this patient had a successful send for (day, channel) yet?" —
-- the dispatcher's idempotency probe.
CREATE INDEX IF NOT EXISTS "patient_checkin_attempts_dedupe_idx"
  ON "resupply"."patient_checkin_attempts" ("journey_id", "day_label", "channel", "outcome");

-- ───────────────────────────────────────────────────────────────────
-- 3. csr_compliance_alerts — at-risk queue for the CSR dashboard.
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "resupply"."csr_compliance_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Optional link back to the journey row that triggered the alert.
  -- Null for alert types that aren't journey-scoped (a patient could
  -- come off-program and still throw a low-usage alert from a manual
  -- import).
  "journey_id" uuid
    REFERENCES "resupply"."patient_onboarding_journeys"("id") ON DELETE SET NULL,
  -- Why the alert fired:
  --   'low_usage'        — adherence below threshold for the elapsed window
  --   'no_response'      — patient hasn't replied to any checkin in N days
  --   'send_failure'     — multiple consecutive vendor failures (likely bad contact)
  --   'manual'           — CSR-created alert
  "alert_type" text NOT NULL,
  -- 'info' | 'warning' | 'critical'.
  -- low_usage starts as 'warning' and escalates to 'critical' if the
  -- gap widens; no_response is always 'warning'; send_failure starts
  -- 'warning' and escalates to 'critical' after 3 consecutive failures.
  "severity" text NOT NULL DEFAULT 'warning',
  -- One-line CSR-facing summary. Bounded — never PHI beyond what's
  -- already on the patient row in their console.
  -- Example: "Day-30: 38% of nights >=4hr (target 70%)"
  "summary" text NOT NULL,
  -- Snapshot of the metric that triggered the alert at flag time, so
  -- the dashboard doesn't have to recompute. Schema is alert-type-
  -- specific; treat as opaque from the database side.
  "metric_snapshot" jsonb,
  -- Lifecycle:
  --   'open'      — visible in the CSR queue
  --   'snoozed'   — hidden until snoozed_until passes
  --   'resolved'  — CSR marked resolved
  "status" text NOT NULL DEFAULT 'open',
  "snoozed_until" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by_email" text,
  "resolved_by_user_id" text,
  "resolution_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "csr_compliance_alerts_alert_type_enum"
    CHECK ("alert_type" IN ('low_usage','no_response','send_failure','manual')),
  CONSTRAINT "csr_compliance_alerts_severity_enum"
    CHECK ("severity" IN ('info','warning','critical')),
  CONSTRAINT "csr_compliance_alerts_status_enum"
    CHECK ("status" IN ('open','snoozed','resolved'))
);

-- CSR queue read path: open alerts for the dashboard, sorted by
-- severity then age.
CREATE INDEX IF NOT EXISTS "csr_compliance_alerts_open_idx"
  ON "resupply"."csr_compliance_alerts" ("status", "severity", "created_at" DESC);

-- Per-patient detail panel.
CREATE INDEX IF NOT EXISTS "csr_compliance_alerts_patient_idx"
  ON "resupply"."csr_compliance_alerts" ("patient_id", "created_at" DESC);

-- One open alert per (patient, alert_type) — defends against the
-- daily scanner double-flagging the same condition. The scanner
-- updates the existing open row (severity / metric_snapshot) rather
-- than creating a second one. Resolved / snoozed rows are exempt so
-- a recurrence after resolution creates a fresh alert.
CREATE UNIQUE INDEX IF NOT EXISTS "csr_compliance_alerts_open_unique"
  ON "resupply"."csr_compliance_alerts" ("patient_id", "alert_type")
  WHERE "status" = 'open';
