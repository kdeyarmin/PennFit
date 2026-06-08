-- 0242_company_calendar_events — shared, staff-wide appointment calendar.
--
-- A company-wide calendar where any signed-in team member can place a
-- patient appointment (virtual / in-person fittings & setups, follow-ups,
-- consultations) so the whole team can see the day's schedule at a glance.
--
-- This is DISTINCT from `appointment_requests` (the inbound, patient-
-- INITIATED triage queue): rows here are the confirmed, scheduled events
-- staff put on the shared calendar. Each event links to a patient row so
-- the patient name is resolved live from `patients` (single source of
-- truth) rather than denormalised onto the event.
--
-- Plain table (no RLS), service-role only. Per ADR 003 — versioned
-- hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."company_calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL DEFAULT 'other',
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "location" text,
  "notes" text,
  -- Who entered the event (auth user id + email for display). Nullable so
  -- a created-by-less backfill can't fail; not an ownership gate — the
  -- whole team can edit the shared calendar.
  "created_by_user_id" uuid,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "company_calendar_events_time_chk"
    CHECK ("ends_at" >= "starts_at"),
  CONSTRAINT "company_calendar_events_type_chk" CHECK (
    "event_type" IN (
      'fitting_virtual',
      'fitting_in_person',
      'setup_virtual',
      'setup_in_person',
      'follow_up',
      'consultation',
      'other'
    )
  )
);
--> statement-breakpoint

-- The calendar reads a date WINDOW (the visible month ± buffer); index the
-- range column so that scan stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS "company_calendar_events_starts_at_idx"
  ON "resupply"."company_calendar_events" ("starts_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "company_calendar_events_patient_idx"
  ON "resupply"."company_calendar_events" ("patient_id");
