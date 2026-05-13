-- patient_address_history — append-only ledger of address changes.
-- See schema/patient-address-history.ts for the full rationale.

CREATE TABLE IF NOT EXISTS "resupply"."patient_address_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "line1" varchar(200),
  "line2" varchar(200),
  "city" varchar(120),
  "state" varchar(64),
  "postal_code" varchar(32),
  "country" varchar(2),
  "reason" varchar(200),
  "changed_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "patient_address_history_patient_idx"
  ON "resupply"."patient_address_history" ("patient_id");
