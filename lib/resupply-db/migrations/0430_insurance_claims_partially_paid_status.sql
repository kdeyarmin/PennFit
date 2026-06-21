-- 0430: add a 'partially_paid' value to insurance_claims.status.
--
-- The ERA reconciler previously marked a claim 'paid' on ANY positive
-- payment, so a partial payment (paid < allowed) looked fully collected —
-- the remaining balance vanished from the collections forecast and the
-- patient was at risk of never being statemented for their share. This adds
-- a distinct 'partially_paid' status the reconciler sets when paid is
-- positive but below the allowed amount; 'paid' now means fully paid.
--
-- Idempotent: drop the existing CHECK (by its stable name) and re-add it
-- with the expanded value set (mirrors 0424). Safe to run more than once.
ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_status_enum"
  CHECK ("status" IN (
    'draft', 'submitting', 'submitted', 'accepted', 'denied',
    'rejected', 'partially_paid', 'paid', 'appealed', 'closed'
  ));
