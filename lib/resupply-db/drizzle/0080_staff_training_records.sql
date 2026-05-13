-- staff_training_records — per-staff training events tracked for
-- DMEPOS accreditation (ACHC, BOC, TJC). See
-- lib/resupply-db/src/schema/staff-training-records.ts for the full
-- rationale, training-type enum, and expiry semantics.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."staff_training_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_user_id" uuid NOT NULL REFERENCES "resupply"."admin_users"("id") ON DELETE CASCADE,
  "training_type" text NOT NULL,
  "course_title" varchar(200),
  "completed_at" date NOT NULL,
  "expires_at" date,
  "credit_hours" numeric(6, 2),
  "provider" varchar(120),
  "certificate_reference" varchar(120),
  "evidence_object_key" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "staff_training_records_training_type_enum"
    CHECK ("training_type" IN (
      'hipaa_privacy', 'hipaa_security',
      'osha_bloodborne', 'osha_general',
      'infection_control', 'fit_test',
      'new_hire_orientation', 'dmepos_supplier_stds',
      'other'
    )),
  CONSTRAINT "staff_training_records_expiry_after_completion"
    CHECK ("expires_at" IS NULL OR "expires_at" >= "completed_at")
);

CREATE INDEX IF NOT EXISTS "staff_training_records_staff_idx"
  ON "resupply"."staff_training_records" ("staff_user_id");

-- Expiry-sweep query: "every training expiring in the next 30
-- days." Index by expiry then type so the dashboard's grouped
-- sort (type → soonest expiry) hits the index.
CREATE INDEX IF NOT EXISTS "staff_training_records_expires_type_idx"
  ON "resupply"."staff_training_records" ("expires_at", "training_type");
