-- 0150_oa_submission_resubmit_chain — track resubmit lineage + which
-- claim IDs were attempted in an Office Ally batch.
--
-- Why
-- ---
-- Two small additions to `office_ally_submissions` that unlock the
-- "one-click resubmit" flow on the new Office Ally Operations admin
-- page:
--
--   1. `attempted_claim_ids uuid[]` — populated on insert with the
--      claim IDs the batch tried to submit. Today, when a batch fails
--      at the transport layer (status='transport_failed'), the per-
--      claim UPDATE that would link `office_ally_submission_id` is
--      skipped (see batch-submit-office-ally route, line 207's
--      `if (submission.upload.ok)` gate). That leaves the failed
--      submission row with zero linked claims and no way to tell what
--      we tried to send. Storing the attempted IDs on insert means
--      "resubmit this failed batch" can recover the exact same list.
--
--   2. `parent_submission_id uuid` — soft self-FK pointing to the
--      submission this row resubmits. Lets the dashboard show the
--      resubmit chain ("attempt 3 of submission #ABC") and lets the
--      audit log walk the lineage when an op is debugging why a claim
--      was sent twice.
--
-- Neither column is required to bill — both are nullable on legacy
-- rows so the migration is backfill-free.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."office_ally_submissions"
  ADD COLUMN IF NOT EXISTS "attempted_claim_ids" uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "parent_submission_id" uuid
    REFERENCES "resupply"."office_ally_submissions"("id")
    ON DELETE SET NULL;
--> statement-breakpoint

-- A submission can't be its own parent. Cheap guard against an
-- accidental self-reference from a buggy resubmit handler.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = '"resupply"."office_ally_submissions"'::regclass
    AND    conname  = 'office_ally_submissions_no_self_parent'
  ) THEN
    ALTER TABLE "resupply"."office_ally_submissions"
      ADD CONSTRAINT "office_ally_submissions_no_self_parent"
      CHECK ("parent_submission_id" IS NULL OR "parent_submission_id" <> "id");
  END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "office_ally_submissions_parent_idx"
  ON "resupply"."office_ally_submissions" ("parent_submission_id")
  WHERE "parent_submission_id" IS NOT NULL;
