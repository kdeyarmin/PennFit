-- recall_remediation_actions — per-asset record of "what we did
-- about the recall" once the patient was notified. See
-- lib/resupply-db/src/schema/recall-remediation-actions.ts for the
-- full enum semantics.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."recall_remediation_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recall_id" uuid NOT NULL REFERENCES "resupply"."equipment_recalls"("id") ON DELETE CASCADE,
  "asset_id" uuid NOT NULL REFERENCES "resupply"."equipment_assets"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "evidence_url" text,
  "notes" text,
  "performed_by_user_id" text,
  "performed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "recall_remediation_actions_action_enum"
    CHECK ("action" IN ('returned_to_manufacturer','destroyed','replaced','patient_declined','lost','unreachable'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "recall_remediation_actions_recall_asset_unique"
  ON "resupply"."recall_remediation_actions" ("recall_id", "asset_id");

CREATE INDEX IF NOT EXISTS "recall_remediation_actions_recall_idx"
  ON "resupply"."recall_remediation_actions" ("recall_id");
