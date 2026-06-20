-- insurance_coverages — verified payer coverage records per patient.
-- See lib/resupply-db/src/schema/insurance-coverages.ts for the full
-- rationale and PHI posture.
--
-- Capture-only in this Tier-2a sprint; Tier-2b adds the real-time
-- eligibility (Availity / Change Healthcare / Waystar) wire
-- integration on top.

CREATE TABLE IF NOT EXISTS "resupply"."insurance_coverages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "rank" text NOT NULL DEFAULT 'primary',
  "payer_name" varchar(120) NOT NULL,
  "plan_name" varchar(120),
  "member_id" varchar(64) NOT NULL,
  "group_number" varchar(64),
  "policyholder_name" varchar(160),
  "policyholder_relationship" text,
  "effective_date" date,
  "termination_date" date,
  "in_network" boolean,
  "deductible_cents" integer,
  "deductible_met_cents" integer,
  "oop_max_cents" integer,
  "copay_cents" integer,
  "capped_rental_status" text,
  "verified_at" timestamp with time zone,
  "verified_by_user_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "insurance_coverages_rank_enum"
    CHECK ("rank" IN ('primary', 'secondary', 'tertiary')),
  CONSTRAINT "insurance_coverages_relationship_enum"
    CHECK ("policyholder_relationship" IS NULL OR
           "policyholder_relationship" IN ('self', 'spouse', 'child', 'other')),
  CONSTRAINT "insurance_coverages_rental_enum"
    CHECK ("capped_rental_status" IS NULL OR
           "capped_rental_status" IN (
             'rental_month_1_to_3',
             'rental_month_4_to_13',
             'purchased',
             'not_applicable'
           )),
  CONSTRAINT "insurance_coverages_amounts_non_negative" CHECK (
    ("deductible_cents" IS NULL OR "deductible_cents" >= 0) AND
    ("deductible_met_cents" IS NULL OR "deductible_met_cents" >= 0) AND
    ("oop_max_cents" IS NULL OR "oop_max_cents" >= 0) AND
    ("copay_cents" IS NULL OR "copay_cents" >= 0)
  )
);

CREATE INDEX IF NOT EXISTS "insurance_coverages_patient_idx"
  ON "resupply"."insurance_coverages" ("patient_id");

CREATE UNIQUE INDEX IF NOT EXISTS "insurance_coverages_patient_rank"
  ON "resupply"."insurance_coverages" ("patient_id", "rank");
