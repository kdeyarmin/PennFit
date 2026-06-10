-- 0265_insurance_claims_submitting_state — close the claim batch
-- double-transmission race (app-review 2026-06-10, P1-1).
--
-- executeOfficeAllyBatchSubmit used to verify "all claims are draft"
-- with a plain read, transmit the 837P over SFTP (60s+ ×3 retries),
-- and only then flip the claims to 'submitted'. During that window a
-- second submitter — operator double-click, the auto-submit worker
-- tick, or a resubmit — passed the same read and transmitted the SAME
-- claims under a fresh ISA13: both files accepted by the clearinghouse,
-- duplicate claims billed to the payer. The fix in
-- lib/billing/office-ally-batch.ts is a claim-then-transmit state
-- machine:
--
--   draft  --claim-->  submitting  --upload ok-->   submitted
--                          |  \--upload failed-->   draft (released)
--                          \--conflict loser----->  draft (released)
--
-- The claim is one conditional UPDATE (`WHERE id IN (...) AND status =
-- 'draft' RETURNING id`); a partial win releases what it took and
-- reports concurrent_submission instead of transmitting.
--
-- This migration only widens the status CHECK to admit the transient
-- 'submitting' state. Operational note: a process crash between claim
-- and outcome leaves claims in 'submitting' — visible in the claims
-- views, excluded from every submit path; after confirming the batch's
-- office_ally_submissions row shows nothing was uploaded, flip them
-- back to 'draft' by hand.
--
-- Re-run-safe: DROP IF EXISTS + ADD; every existing value is a member
-- of the widened set, so the ADD's validation scan cannot fail.
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_status_enum"
  CHECK ("status" IN (
    'draft', 'submitting', 'submitted', 'accepted', 'denied',
    'paid', 'appealed', 'closed'
  ));
