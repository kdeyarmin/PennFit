-- 0326_asset_recovery_cases — track recovery of CPAP machines from
-- patients who have discontinued therapy, for refurbishment / redeploy.
--
-- Closes the one competitor offering (VGM "Asset Recovery") with no
-- PennFit analog. PennFit already DETECTS likely discontinuation via the
-- low-usage smart triggers and the lapsed-customer win-back job; this
-- table is the ACTION half — a worklist of recovery cases a CSR/RT works
-- from "identified" through to the device being "received" and
-- "redeployed" (or "closed_unrecovered").
--
-- patient_id is an opaque uuid reference to resupply.patients (kept as a
-- plain column, not a hard FK, so a case can also be opened ad hoc).
-- patient_label is a denormalized display name for the worklist; it is
-- PHI and is NEVER written to the audit log (audit records case id +
-- status only).
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."asset_recovery_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid,
  "patient_label" text,
  "device_label" varchar(160),
  "device_serial" varchar(120),
  "status" text NOT NULL DEFAULT 'identified',
  "reason" text NOT NULL DEFAULT 'discontinued',
  "tracking_number" varchar(120),
  "return_label_url" text,
  "notes" text,
  "created_by_email" text,
  "updated_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_recovery_status_enum" CHECK (
    "status" IN (
      'identified',
      'outreach',
      'label_sent',
      'in_transit',
      'received',
      'redeployed',
      'closed_unrecovered'
    )
  ),
  CONSTRAINT "asset_recovery_reason_enum" CHECK (
    "reason" IN (
      'discontinued',
      'non_compliant',
      'deceased',
      'upgraded',
      'insurance_change',
      'other'
    )
  )
);

CREATE INDEX IF NOT EXISTS "asset_recovery_cases_status_idx"
  ON "resupply"."asset_recovery_cases" ("status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "asset_recovery_cases_patient_idx"
  ON "resupply"."asset_recovery_cases" ("patient_id");
