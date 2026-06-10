-- 0303_secondary_claims_unique_per_primary.sql
--
-- Close the generate-secondary check-then-insert race. The
-- /admin/claims/:id/generate-secondary route dedupes with a SELECT
-- followed by an unconditional INSERT, and migration 0199 added only a
-- PLAIN index on primary_claim_id — no unique constraint. Two
-- operators (or one double-click) generating the secondary for the
-- same primary claim concurrently both pass the SELECT and both
-- INSERT, producing duplicate secondary claims with copied line items
-- that can each be batch-submitted to the payer.
--
-- A partial unique index makes the database the arbiter: one
-- secondary-sequence claim per primary claim. The route maps a 23505
-- on this index to its existing 409 secondary_exists response.
--
-- Guarded: if a database already holds duplicate secondaries the index
-- cannot be created — we skip with a NOTICE instead of erroring (a
-- deploy-gating failure would be worse than the race). Resolve the
-- duplicates by hand (void/delete the extras), then re-run this
-- migration's CREATE UNIQUE INDEX manually or via a follow-up
-- corrective migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'resupply'
      AND indexname = 'insurance_claims_secondary_per_primary_unique'
  ) THEN
    RAISE NOTICE 'insurance_claims_secondary_per_primary_unique already exists; skipping';
  ELSIF EXISTS (
    SELECT 1
    FROM resupply.insurance_claims
    WHERE payer_sequence = 'secondary' AND primary_claim_id IS NOT NULL
    GROUP BY primary_claim_id
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'duplicate secondary claims exist for at least one primary; unique index NOT created — resolve the duplicates, then create insurance_claims_secondary_per_primary_unique by hand';
  ELSE
    CREATE UNIQUE INDEX insurance_claims_secondary_per_primary_unique
      ON resupply.insurance_claims (primary_claim_id)
      WHERE payer_sequence = 'secondary' AND primary_claim_id IS NOT NULL;
  END IF;
END $$;
