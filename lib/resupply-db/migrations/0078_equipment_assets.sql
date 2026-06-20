-- equipment_assets — clinical "which device does this patient have"
-- registry. Required for manufacturer recall workflows (Philips
-- DreamStation 2021 was the case that proved every DME needs this).
-- See lib/resupply-db/src/schema/equipment-assets.ts for the full
-- rationale, PHI posture, and lifecycle state machine.
--
-- Distinct from shop_customers.cpap_device_json (patient-supplied
-- self-service jsonb) and Pacware warehouse inventory (per the
-- check-resupply-architecture.sh Rule 14 boundary). This is the
-- patient ↔ serial-number clinical link — what the supplier
-- dispensed, when, against which Rx, and what its current state is.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+. Forward-
-- deploy-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "resupply"."equipment_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "prescription_id" uuid REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL,
  "device_class" text NOT NULL,
  "manufacturer" varchar(80) NOT NULL,
  "model" varchar(120) NOT NULL,
  "serial_number" varchar(80) NOT NULL,
  "pressure_setting" varchar(80),
  "humidifier_setting" varchar(32),
  "status" text NOT NULL DEFAULT 'active',
  "dispensed_at" date,
  "dispensing_note" text,
  "recall_id" uuid,
  "metadata" jsonb,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "equipment_assets_device_class_enum"
    CHECK ("device_class" IN (
      'cpap', 'auto_cpap', 'bipap', 'asv', 'avaps',
      'humidifier', 'oximeter', 'other'
    )),
  CONSTRAINT "equipment_assets_status_enum"
    CHECK ("status" IN ('active', 'returned', 'recalled', 'retired')),
  CONSTRAINT "equipment_assets_serial_not_empty"
    CHECK (length(trim("serial_number")) > 0)
);

CREATE INDEX IF NOT EXISTS "equipment_assets_patient_idx"
  ON "resupply"."equipment_assets" ("patient_id");

-- Dedupe: same manufacturer can never re-issue the same serial.
-- A CSR mistyping a serial across patients fails at insert rather
-- than creating a phantom dupe.
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_assets_manufacturer_serial_unique"
  ON "resupply"."equipment_assets" ("manufacturer", "serial_number");

-- Recall-scan query: pull every active row matching a (mfr, model)
-- tuple, then filter by serial criteria in application code.
CREATE INDEX IF NOT EXISTS "equipment_assets_manufacturer_model_status_idx"
  ON "resupply"."equipment_assets" ("manufacturer", "model", "status");
