-- patient_followups — internal CSR-scheduled callback / check-back
-- reminders attached to a patient. Mirrors shop_customer_followups
-- (migration 0039) but keyed on the patient.
--
-- Why a separate table from shop_customer_followups: patients and
-- shop customers are different identity surfaces (the resupply patient
-- flow is independent of the cash-pay storefront), so each gets its
-- own followup table to keep the FK + ON DELETE CASCADE behavior
-- correct per surface.
--
-- Lifecycle is identical: open (completed_at IS NULL) → completed.
-- No edit/delete; revisions are new rows. Append-only audit trail.
--
-- Audit verbs:
--   patient.followup.create   — new followup
--   patient.followup.complete — mark complete
-- Both record patient_id + body_length only — never the body.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_followups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "completed_by_email" text,
  "completed_by_user_id" text,
  "created_by_email" text NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Open followups, ordered by due_at — drives the "what's overdue"
-- and "what's due soon" panel queries.
CREATE INDEX IF NOT EXISTS "patient_followups_open_due_idx"
  ON "resupply"."patient_followups" ("due_at")
  WHERE "completed_at" IS NULL;

-- Per-patient history (open + completed), newest-due first.
CREATE INDEX IF NOT EXISTS "patient_followups_patient_due_idx"
  ON "resupply"."patient_followups" ("patient_id", "due_at" DESC);
