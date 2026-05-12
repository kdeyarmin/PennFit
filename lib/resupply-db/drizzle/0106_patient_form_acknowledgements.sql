-- patient_form_acknowledgements — click-through e-sign record for
-- HIPAA NPP / AOB / ABN / Financial Responsibility forms.
-- See schema/patient-form-acknowledgements.ts for the rationale.

CREATE TABLE IF NOT EXISTS "resupply"."patient_form_acknowledgements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "form_kind" varchar(48) NOT NULL,
  "form_version" varchar(24) NOT NULL,
  "signed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "signed_from_ip" varchar(64),
  "source" text NOT NULL DEFAULT 'patient_portal',
  "document_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_form_acks_kind_enum"
    CHECK ("form_kind" IN (
      'hipaa_npp', 'aob', 'abn',
      'financial_responsibility', 'supplier_standards'
    )),
  CONSTRAINT "patient_form_acks_source_enum"
    CHECK ("source" IN ('patient_portal', 'csr_recorded', 'paper_scan'))
);

CREATE INDEX IF NOT EXISTS "patient_form_acks_patient_idx"
  ON "resupply"."patient_form_acknowledgements" ("patient_id");

CREATE UNIQUE INDEX IF NOT EXISTS "patient_form_acks_patient_kind_version_unique"
  ON "resupply"."patient_form_acknowledgements"
  ("patient_id", "form_kind", "form_version");
