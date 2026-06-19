-- patient_coaching_plans — adherence outreach workflow that layers
-- on top of the flat csr_compliance_alerts. See
-- lib/resupply-db/src/schema/patient-coaching-plans.ts for the full
-- state machine + rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."patient_coaching_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "source_alert_id" uuid,
  "opened_by_user_id" text,
  "status" varchar(32) NOT NULL DEFAULT 'open',
  "target_compliance_pct" integer NOT NULL DEFAULT 70,
  "latest_compliance_pct" numeric(5, 2),
  "target_date" timestamp with time zone,
  "latest_outreach_at" timestamp with time zone,
  "resolution_note" text,
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_coaching_plans_status_enum"
    CHECK ("status" IN ('open','outreach_made','improving','escalated','resolved','abandoned')),
  CONSTRAINT "patient_coaching_plans_pct_range"
    CHECK ("target_compliance_pct" >= 0 AND "target_compliance_pct" <= 100)
);

CREATE INDEX IF NOT EXISTS "patient_coaching_plans_patient_idx"
  ON "resupply"."patient_coaching_plans" ("patient_id");

CREATE INDEX IF NOT EXISTS "patient_coaching_plans_open_idx"
  ON "resupply"."patient_coaching_plans" ("opened_at")
  WHERE closed_at IS NULL;
