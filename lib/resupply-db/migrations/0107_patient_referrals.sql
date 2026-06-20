-- patient_referrals — patient-to-patient word-of-mouth attribution.
-- See schema/patient-referrals.ts for the rationale.

CREATE TABLE IF NOT EXISTS "resupply"."patient_referrals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "referrer_patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "code" varchar(16) NOT NULL,
  "referee_email" varchar(200),
  "referee_name" varchar(160),
  "converted_at" timestamp with time zone,
  "converted_order_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_referrals_status_enum"
    CHECK ("status" IN ('pending', 'converted', 'expired', 'revoked')),
  CONSTRAINT "patient_referrals_code_format"
    CHECK ("code" ~ '^[A-Za-z0-9_-]{6,16}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "patient_referrals_code_unique"
  ON "resupply"."patient_referrals" ("code");

CREATE INDEX IF NOT EXISTS "patient_referrals_referrer_idx"
  ON "resupply"."patient_referrals" ("referrer_patient_id");
