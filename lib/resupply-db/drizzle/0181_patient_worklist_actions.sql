-- 0181 — patient worklist action state (Therapy Fleet phase 3).
--
-- The Therapy Fleet outreach worklist (/admin/therapy-fleet/worklist,
-- migration 0179) is stateless: every load recomputes the same
-- at-risk / high-leak / device-silent patients from
-- patient_therapy_nights, with no way for a CSR to mark one handled.
-- That makes it a report, not a work queue — a patient a CSR already
-- called keeps re-surfacing the next day.
--
-- This table records the CURRENT triage state per patient (one row per
-- patient, upserted) so the worklist route can hide snoozed/resolved
-- patients and badge acknowledged/contacted ones. It is intentionally
-- a current-state table, not an event log — the audit trail
-- (therapy.worklist.action.set) carries the history; this carries only
-- "where does this patient stand right now".
--
--   status        one of acknowledged | snoozed | contacted | resolved
--   snooze_until  date the patient should reappear (snoozed only); the
--                 worklist route treats a future snooze_until as "hide".
--   note          optional short CSR note. MAY contain PHI — admin-only
--                 read, never logged (the audit envelope records status
--                 + patient_id only, never the note body).
--
-- PHI / log posture: this table is reachable only via the service-role
-- client (admin-gated routes). RLS is enabled deny-all to match the
-- 0169/0170 posture; service_role bypasses it.

CREATE TABLE IF NOT EXISTS "resupply"."patient_worklist_actions" (
  "patient_id" uuid PRIMARY KEY
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "status" text NOT NULL
    CHECK ("status" IN ('acknowledged', 'snoozed', 'contacted', 'resolved')),
  "snooze_until" date,
  "note" text,
  "updated_by_email" text,
  "updated_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Partial index over still-active snoozes — the worklist route filters
-- "snooze_until > current_date" to decide which handled patients to
-- keep hidden.
CREATE INDEX IF NOT EXISTS "patient_worklist_actions_snooze_idx"
  ON "resupply"."patient_worklist_actions" ("snooze_until")
  WHERE "snooze_until" IS NOT NULL;
--> statement-breakpoint

-- RLS — match the deny-all posture established in 0169/0170.
-- service_role (the only runtime data path) bypasses RLS; enabling it
-- with no policy makes the table deny-all to anon/authenticated, the
-- intended end-state for a service-role-only schema. 0170's catalog
-- loop already ran, so a new table must enable it here.
ALTER TABLE "resupply"."patient_worklist_actions" ENABLE ROW LEVEL SECURITY;
