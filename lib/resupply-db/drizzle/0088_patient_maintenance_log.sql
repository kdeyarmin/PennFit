-- patient_maintenance_log — per-patient hygiene completion record.
-- See lib/resupply-db/src/schema/patient-maintenance-log.ts for the
-- full rationale (why a log + cadence-from-code, not a "next due"
-- column on patients, what surveys the patient-facing checklist
-- replaces, and the PHI posture).
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."patient_maintenance_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "task_key" varchar(64) NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'patient_portal',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_maintenance_log_task_key_shape"
    CHECK ("task_key" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "patient_maintenance_log_source_enum"
    CHECK ("source" IN ('patient_portal', 'csr_proxy', 'system'))
);

CREATE INDEX IF NOT EXISTS "patient_maintenance_log_patient_task_completed_idx"
  ON "resupply"."patient_maintenance_log" ("patient_id", "task_key", "completed_at");
