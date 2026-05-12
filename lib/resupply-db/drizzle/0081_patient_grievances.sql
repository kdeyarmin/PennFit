-- patient_grievances — formal patient complaints, grievances, and
-- adverse events under one typed table.
-- See lib/resupply-db/src/schema/patient-grievances.ts for the full
-- rationale (why three concerns share one row shape), severity +
-- status state machine, and PHI posture.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."patient_grievances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "equipment_asset_id" uuid REFERENCES "resupply"."equipment_assets"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'low',
  "source" text NOT NULL,
  "summary" varchar(200) NOT NULL,
  "description" text,
  "received_at" date NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "acknowledged_at" timestamp with time zone,
  "acknowledged_by_user_id" uuid,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" uuid,
  "reported_to_fda" text NOT NULL DEFAULT 'not_applicable',
  "fda_report_reference" varchar(64),
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_grievances_kind_enum"
    CHECK ("kind" IN ('complaint', 'grievance', 'adverse_event')),
  CONSTRAINT "patient_grievances_severity_enum"
    CHECK ("severity" IN ('low', 'moderate', 'high')),
  CONSTRAINT "patient_grievances_source_enum"
    CHECK ("source" IN ('phone', 'email', 'sms', 'in_person', 'letter', 'portal', 'other')),
  CONSTRAINT "patient_grievances_status_enum"
    CHECK ("status" IN ('open', 'acknowledged', 'escalated', 'resolved', 'reopened')),
  CONSTRAINT "patient_grievances_reported_to_fda_enum"
    CHECK ("reported_to_fda" IN ('yes', 'no', 'not_applicable'))
);

CREATE INDEX IF NOT EXISTS "patient_grievances_patient_idx"
  ON "resupply"."patient_grievances" ("patient_id");

-- Triage view: open / acknowledged grievances sorted by severity
-- then received-at, so the urgent ones surface first.
CREATE INDEX IF NOT EXISTS "patient_grievances_status_severity_received_idx"
  ON "resupply"."patient_grievances" ("status", "severity", "received_at");

-- Foreign key constraints for audit trail (who acknowledged/resolved)
ALTER TABLE "resupply"."patient_grievances"
  ADD CONSTRAINT "fk_patient_grievances_acknowledged_by"
  FOREIGN KEY ("acknowledged_by_user_id")
  REFERENCES "resupply"."staff_users"("id")
  ON DELETE SET NULL;

ALTER TABLE "resupply"."patient_grievances"
  ADD CONSTRAINT "fk_patient_grievances_resolved_by"
  FOREIGN KEY ("resolved_by_user_id")
  REFERENCES "resupply"."staff_users"("id")
  ON DELETE SET NULL;
