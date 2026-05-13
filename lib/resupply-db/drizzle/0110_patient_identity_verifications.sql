-- patient_identity_verifications — audit trail of identity-check
-- events. We never store the SSN or government ID itself; only the
-- outcome and method.

CREATE TABLE IF NOT EXISTS "resupply"."patient_identity_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "method" varchar(32) NOT NULL,
  "result" varchar(16) NOT NULL,
  "notes" text,
  "verified_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_identity_verifications_method_enum"
    CHECK ("method" IN ('dob_last4_ssn','gov_id_upload','video_attest','in_person')),
  CONSTRAINT "patient_identity_verifications_result_enum"
    CHECK ("result" IN ('pass','fail','skipped'))
);

CREATE INDEX IF NOT EXISTS "patient_identity_verifications_patient_idx"
  ON "resupply"."patient_identity_verifications" ("patient_id");
