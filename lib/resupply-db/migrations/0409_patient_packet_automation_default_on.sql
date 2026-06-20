-- 0409_patient_packet_automation_default_on — turn the patient-packet
-- automation flags ON by default.
--
-- Background
-- ----------
-- The new-patient document packet workflow shipped with two automation
-- toggles seeded OFF (deliberate opt-in):
--   * patient_packets.autosend_on_delivery (migration 0222) — email the
--     new-patient packet the first time an order is delivered to a linked
--     patient.
--   * patient_packets.autoremind          (migration 0223) — re-send the
--     signing link to patients who have not finished signing, on a fixed
--     cadence (daily sweep, capped at PATIENT_PACKET_MAX_REMINDERS).
--
-- Per the business owner, paperwork should go out — and chase itself —
-- automatically so signatures are collected promptly without a CSR
-- remembering to click "Send"/"Resend" on every patient. Both code paths
-- are already safe to run unattended:
--   * autosend fires inline per NEW delivery transition (never a
--     retroactive backfill) and is one-time per patient (skips when the
--     patient already has any non-voided packet), so flipping it on does
--     not blast historically-delivered patients.
--   * the reminder sweep claims each nudge with an optimistic
--     compare-and-set, honours the 9am–8pm TCPA send window per patient,
--     caps the number of nudges, and rolls the claim back when delivery
--     fails — so it cannot strand a patient with a dead link or over-nudge.
--
-- This migration flips the platform default to ON. Because new tenants
-- copy the seed org's flag values at onboarding (tenant-signup-service.ts
-- / scripts/tenant-onboard.ts) and the runtime reader falls back to the
-- seed org for any (org, key) a tenant lacks, updating every existing row
-- here also makes ON the default for tenants provisioned later.
--
-- Idempotent: the enabled flip is guarded on `enabled = false`, so a
-- replay (or a deploy after an operator has since turned a tenant OFF
-- from Control Center) is a no-op. Migrations apply once via the ledger,
-- so this never re-enables a flag an operator later disables.
--
-- Per ADR 003 — versioned hand-authored migration.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts (keys unchanged here).

-- Flip the toggles ON for every tenant that still carries the seeded
-- default (enabled = false). Tenants that already enabled a flag are
-- left untouched (already true → not matched).
UPDATE "resupply"."feature_flags"
SET "enabled" = true,
    "updated_at" = now()
WHERE "key" IN (
    'patient_packets.autosend_on_delivery',
    'patient_packets.autoremind'
  )
  AND "enabled" = false;

--> statement-breakpoint

-- Refresh the catalog copy so the Control Center description matches the
-- new ON-by-default posture (the seeded text said "OFF by default").
UPDATE "resupply"."feature_flags"
SET "description" = 'Automatically email a new-patient document packet for e-signature the first time an order is delivered to a customer linked to a patient record. One-time per patient; the admin "Send packet" action is always available regardless of this toggle. ON by default — turn OFF to pause automatic sends.'
WHERE "key" = 'patient_packets.autosend_on_delivery';

--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "description" = 'Automatically re-send the signing link to patients who have not finished their document packet, on a fixed cadence with a maximum number of nudges. The sweep runs daily (override with PATIENT_PACKET_REMINDER_CRON) and only texts inside the 9am–8pm TCPA window. ON by default — turn OFF to pause the sends without changing the schedule.'
WHERE "key" = 'patient_packets.autoremind';
