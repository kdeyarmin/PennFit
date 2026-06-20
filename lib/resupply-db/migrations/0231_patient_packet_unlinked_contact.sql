-- Patient signature packets — send to an arbitrary contact (no patient).
--
-- Until now every packet was anchored to a resupply.patients row
-- (patient_id NOT NULL) and could only be created from the patient-
-- scoped admin route. CSRs asked to be able to send a signature packet
-- to an email address or phone number directly — without first finding
-- the patient — and to have it automatically file onto the patient's
-- chart when the contact matches an existing patient.
--
-- Two schema changes support that:
--
--   1. patient_id becomes NULLABLE. A packet sent to a contact that
--      doesn't match any patient has no chart to attach to; it still
--      exists as a standalone, signable envelope. When the contact DOES
--      resolve to a single patient, the send path sets patient_id so the
--      packet shows up under that patient's chart exactly as before.
--      The FK + ON DELETE CASCADE are preserved for the populated case.
--
--   2. recipient_phone is snapshotted on the packet (alongside the
--      existing recipient_email snapshot). The resend route previously
--      re-derived the SMS number from the linked patient row; an
--      unlinked packet has no such row, so the number it was sent to
--      must be recorded on the packet itself. Linked packets snapshot it
--      too, so resend no longer needs to re-read the patient row.
--
-- Both statements are idempotent: DROP NOT NULL is a no-op when the
-- column is already nullable, and ADD COLUMN IF NOT EXISTS is guarded.

ALTER TABLE "resupply"."patient_packets"
  ALTER COLUMN "patient_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."patient_packets"
  ADD COLUMN IF NOT EXISTS "recipient_phone" text;
