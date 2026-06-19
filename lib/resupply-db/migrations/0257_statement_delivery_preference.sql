-- 0257_statement_delivery_preference — emailed-vs-mailed patient
-- statement / bill delivery.
--
-- Adds a per-patient delivery preference so generated statements can be
-- SEGREGATED at creation time:
--   * 'email' — the statement is emailed to the patient (the existing
--               consent-gated send path).
--   * 'mail'  — the statement is routed to a print / mail worklist
--               instead of being emailed or texted.
--
-- Default 'mail'. Paper is the safe default until a patient (or a CSR on
-- their behalf) explicitly opts into emailed statements, so we never
-- email PHI to an address the patient never chose for billing. Existing
-- rows therefore become 'mail' and nothing is auto-emailed on deploy;
-- statement send is operator-triggered regardless.
--
-- Also widens the statement delivery_channel CHECK to allow 'mail' so a
-- statement marked mailed records the channel it actually went out on
-- (email | sms | mail) — matching the existing delivery_method options
-- (migration 0137) and the new mark-mailed action.
--
-- Per ADR 003 — versioned hand-authored migration. Additive + defaulted;
-- safe to re-run (IF NOT EXISTS / DROP-then-ADD constraint).

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "statement_delivery_method" text NOT NULL DEFAULT 'mail';
--> statement-breakpoint
ALTER TABLE "resupply"."patients"
  DROP CONSTRAINT IF EXISTS "patients_statement_delivery_method_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."patients"
  ADD CONSTRAINT "patients_statement_delivery_method_enum"
  CHECK ("statement_delivery_method" IN ('email', 'mail'));
--> statement-breakpoint

ALTER TABLE "resupply"."patient_billing_statements"
  DROP CONSTRAINT IF EXISTS "patient_billing_statements_delivery_channel_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."patient_billing_statements"
  ADD CONSTRAINT "patient_billing_statements_delivery_channel_enum"
  CHECK (
    "delivery_channel" IS NULL
    OR "delivery_channel" IN ('email', 'sms', 'mail')
  );
--> statement-breakpoint

-- The mail worklist scans for delivery_method = 'mail' awaiting a print run.
CREATE INDEX IF NOT EXISTS "patient_billing_statements_delivery_method_status_idx"
  ON "resupply"."patient_billing_statements" ("delivery_method", "delivery_status");
