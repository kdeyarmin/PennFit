-- 0418: add a 'rejected' value to insurance_claims.status.
--
-- A 277CA clearinghouse rejection is a FRONT-END rejection (the claim
-- bounced before payer adjudication, e.g. bad data) — semantically
-- distinct from a payer 'denied' adjudication. Previously the 277CA
-- handler set no claim status, so a clearinghouse-rejected claim sat at
-- 'submitted' (looked in-flight) and the biller never saw it for rework.
--
-- Idempotent: drop the existing CHECK (by its stable name) and re-add it
-- with the expanded value set. Safe to run more than once.
ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_status_enum"
  CHECK ("status" IN (
    'draft', 'submitting', 'submitted', 'accepted', 'denied',
    'rejected', 'paid', 'appealed', 'closed'
  ));
