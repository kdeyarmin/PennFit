-- prior_authorizations — payer-issued auths to dispense a specific
-- HCPCS code for a specific patient under a specific coverage,
-- valid through a specific date. See
-- lib/resupply-db/src/schema/prior-authorizations.ts for the full
-- rationale.
--
-- Capture-only in this Tier-2a sprint; Tier-2b wires automated PA
-- submission where the payer supports it.

CREATE TABLE IF NOT EXISTS "resupply"."prior_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "insurance_coverage_id" uuid REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL,
  "hcpcs_code" varchar(12) NOT NULL,
  "payer_name" varchar(120) NOT NULL,
  "auth_number" varchar(64),
  "status" text NOT NULL DEFAULT 'draft',
  "requested_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "decision_at" timestamp with time zone,
  "approved_through" date,
  "denial_reason" text,
  "document_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "prior_authorizations_status_enum"
    CHECK ("status" IN (
      'draft', 'submitted', 'approved', 'denied', 'appealed', 'expired'
    ))
);

CREATE INDEX IF NOT EXISTS "prior_authorizations_patient_idx"
  ON "resupply"."prior_authorizations" ("patient_id");

CREATE INDEX IF NOT EXISTS "prior_authorizations_patient_hcpcs_status_idx"
  ON "resupply"."prior_authorizations" ("patient_id", "hcpcs_code", "status");
