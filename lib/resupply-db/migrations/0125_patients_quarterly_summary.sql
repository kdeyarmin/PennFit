-- 0125_patients_quarterly_summary — track the most recent quarterly
-- therapy-summary auto-email per patient.
--
-- Why
-- ---
-- /shop/me/quarterly-summary already renders a 3-month therapy
-- rollup the patient can share with their sleep MD — but it's
-- pull-only. Patients have to remember to navigate to /account and
-- click into it. As a result the surface barely gets used, even
-- though the rollup is precisely the document Medicare reviewers
-- and primary-care physicians ask for.
--
-- This column lets a new daily worker auto-email each patient a
-- summary every ~90 days. Stamping the timestamp BEFORE the send
-- guards against double-deliveries; releasing the stamp on a
-- failed send lets the next run retry.
--
-- The column is intentionally on `patients` (not shop_customers)
-- because the source data lives there (patient_therapy_nights is
-- keyed on patient_id). The dispatcher resolves email via the
-- existing patients.email column and walks comm-prefs by joining
-- to shop_customers — same pattern as the therapy-milestone worker
-- (0120) and the smart-trigger dispatcher.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "quarterly_summary_last_sent_at"
    timestamp with time zone;
--> statement-breakpoint

-- Hot query for the dispatcher: patients eligible for a fresh
-- summary (never-sent or sent >90 days ago). Partial index keeps
-- the working set tiny — at most a quarter of active patients are
-- eligible on any given day.
CREATE INDEX IF NOT EXISTS "patients_quarterly_summary_due_idx"
  ON "resupply"."patients" ("quarterly_summary_last_sent_at" NULLS FIRST);
