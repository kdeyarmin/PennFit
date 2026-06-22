-- 0455_referral_adherence_reports_status_sending — add a 'sending' claim
-- status to the referral-adherence idempotency ledger (Referral CRM Phase 3).
--
-- WHY
--   The worker previously checked-for-existing → sent → recorded the row in
--   that order, so two overlapping ticks / workers could BOTH pass the
--   existence check and BOTH disclose the PHI attestation before either wrote
--   a row (`ignoreDuplicates` only suppressed the second DB row AFTER the
--   duplicate disclosure already went out). The fix claims the unique
--   (org_id, patient_id, provider_id, window_days) slot BEFORE the vendor
--   call by inserting a row with status='sending'; the unique-constraint
--   violation on a concurrent insert is the concurrency guard (loser skips,
--   no second send). After the send the row is UPDATEd to 'sent'/'failed'.
--
--   The pre-existing CHECK constraint only permitted 'sent' | 'failed', which
--   would reject the in-flight claim row — this migration widens it to also
--   allow 'sending'. A 'sending' row that never reaches a terminal status
--   (worker crashed mid-send) still occupies the unique slot, which is the
--   intended safe default for a PHI disclosure: it is NOT re-sent on the next
--   tick. Operators re-drive stuck/failed rows explicitly.
--
-- PHI POSTURE
--   Unchanged — this table holds NO therapy text and NO patient identity
--   beyond the patient_id FK (see 0452).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."referral_adherence_reports"
  DROP CONSTRAINT IF EXISTS "referral_adherence_reports_status_check";
--> statement-breakpoint

ALTER TABLE "resupply"."referral_adherence_reports"
  ADD CONSTRAINT "referral_adherence_reports_status_check"
  CHECK ("status" IN ('sending', 'sent', 'failed'));
