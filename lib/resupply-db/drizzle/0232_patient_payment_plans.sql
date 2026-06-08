-- 0232_patient_payment_plans — in-app patient payment-plan tracker
-- (biller #B7).
--
-- The platform records individual patient_payments but had no way to
-- structure a balance into a scheduled installment plan ("$50/mo for 6
-- months") and track what's paid / remaining / overdue. A biller did
-- this on paper. This adds the tracking substrate:
--
--   * patient_payment_plans            — header: patient, total, count,
--                                        cadence, start date, lifecycle
--                                        status.
--   * patient_payment_plan_installments — the generated schedule, one row
--                                        per installment, each settled
--                                        independently (paid / waived) and
--                                        optionally linked to the
--                                        patient_payments row that cleared
--                                        it.
--
-- This slice is RECORD-KEEPING only — it does not move money. Automatic
-- Stripe charging against the schedule is a deliberate follow-up.
--
-- Plain tables (no RLS) — service-role client only; AR data, no new PHI
-- beyond the patient FK already governed elsewhere. Per ADR 003 —
-- versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_payment_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id"),
  "total_amount_cents" integer NOT NULL,
  "installment_count" integer NOT NULL,
  "frequency" text NOT NULL DEFAULT 'monthly',
  "start_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "note" text,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_payment_plans_total_chk" CHECK ("total_amount_cents" > 0),
  CONSTRAINT "patient_payment_plans_count_chk" CHECK ("installment_count" > 0),
  CONSTRAINT "patient_payment_plans_freq_chk"
    CHECK ("frequency" IN ('weekly', 'biweekly', 'monthly')),
  CONSTRAINT "patient_payment_plans_status_chk"
    CHECK ("status" IN ('active', 'completed', 'cancelled'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_payment_plans_patient_idx"
  ON "resupply"."patient_payment_plans" ("patient_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."patient_payment_plan_installments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id" uuid NOT NULL
    REFERENCES "resupply"."patient_payment_plans"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "due_date" date NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'scheduled',
  "paid_at" timestamp with time zone,
  "patient_payment_id" uuid REFERENCES "resupply"."patient_payments"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ppp_installments_amount_chk" CHECK ("amount_cents" >= 0),
  CONSTRAINT "ppp_installments_seq_chk" CHECK ("seq" > 0),
  CONSTRAINT "ppp_installments_status_chk"
    CHECK ("status" IN ('scheduled', 'paid', 'overdue', 'waived')),
  CONSTRAINT "ppp_installments_unique_seq" UNIQUE ("plan_id", "seq")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ppp_installments_plan_idx"
  ON "resupply"."patient_payment_plan_installments" ("plan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ppp_installments_due_idx"
  ON "resupply"."patient_payment_plan_installments" ("status", "due_date");
