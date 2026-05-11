-- equipment_recalls — manufacturer recall notices tracked by the
-- supplier, with match criteria the recall-scan engine uses to
-- intersect with the equipment_assets registry.
-- See lib/resupply-db/src/schema/equipment-recalls.ts for the full
-- rationale; metadata is non-PHI but the join product with patients
-- (which patient owns which affected serial) is PHI and is computed
-- only inside the admin-gated /admin/equipment-recalls/:id/scan route.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."equipment_recalls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recall_reference" varchar(64) NOT NULL,
  "title" varchar(200) NOT NULL,
  "manufacturer" varchar(80) NOT NULL,
  "model_match" varchar(120),
  "serial_match" jsonb,
  "severity" text NOT NULL DEFAULT 'priority',
  "status" text NOT NULL DEFAULT 'active',
  "issued_at" date,
  "deadline_at" date,
  "reference_url" text,
  "description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "equipment_recalls_severity_enum"
    CHECK ("severity" IN ('urgent', 'priority', 'advisory')),
  CONSTRAINT "equipment_recalls_status_enum"
    CHECK ("status" IN ('active', 'closed')),
  CONSTRAINT "equipment_recalls_reference_not_empty"
    CHECK (length(trim("recall_reference")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "equipment_recalls_reference_unique"
  ON "resupply"."equipment_recalls" ("recall_reference");

CREATE INDEX IF NOT EXISTS "equipment_recalls_status_idx"
  ON "resupply"."equipment_recalls" ("status", "severity");
