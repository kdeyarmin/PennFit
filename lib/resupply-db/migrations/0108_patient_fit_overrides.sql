-- patient_fit_overrides — CSR-curated override of the camera-based
-- mask-fitting recommendation. One row per patient.
-- See schema/patient-fit-overrides.ts for the rationale.

CREATE TABLE IF NOT EXISTS "resupply"."patient_fit_overrides" (
  "patient_id" uuid PRIMARY KEY
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "recommended_mask_sku" varchar(64) NOT NULL,
  "recommended_mask_size" varchar(16),
  "rationale" text,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
