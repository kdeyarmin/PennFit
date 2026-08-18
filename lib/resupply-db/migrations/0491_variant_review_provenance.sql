-- 0491_variant_review_provenance — cite the source behind a sign-off.
--
-- Why
-- ---
-- `mask_variant_reviews` (0482) records THAT a tenant's clinician signed
-- off a size's millimetre bands, and by whom and when. It does not record
-- WHAT they checked it against. That omission is the difference between a
-- fit report an auditor accepts and one they don't: "reviewed by
-- rt@dme.com" is an assertion, while "verified against the ResMed AirFit
-- N20 fitting template, rev C" is evidence.
--
-- It matters more here than it would elsewhere because of where the
-- catalog came from. The 0486 seed bands are clinically-reasoned
-- ESTIMATES, not published manufacturer geometry — 0485's header says so
-- and that is precisely why `fitter.clinical_assessment` ships OFF. The
-- sign-off queue is the step that converts estimates into something a
-- tenant is willing to fit patients against, so the queue is exactly
-- where the provenance has to be captured. Capturing it afterwards is
-- not possible: the reviewer is the only person who knows what they
-- looked at.
--
-- Model
-- -----
--   source_kind  — WHAT CLASS of evidence, constrained so the values stay
--                  aggregatable. 'clinical_judgment' is deliberately one
--                  of them: a reviewer who is going on experience rather
--                  than a document should be able to say so honestly
--                  instead of being pushed into overclaiming a citation.
--   source_ref   — the free-text pointer (document title + revision, URL,
--                  or a note on how it was physically measured).
--
-- Both are NULLABLE. Existing rows predate the column and there is no
-- honest value to backfill them with — a NULL here reads as "sign-off
-- recorded before provenance was captured", which is true, where any
-- default would be a fabrication. New sign-offs are asked for a source by
-- the admin UI, but the column is not NOT NULL: an RT working through a
-- 250-row queue must never be blocked from recording a legitimate
-- approval because a citation field is awkward.
--
-- No new index. These columns are read alongside a review row that is
-- already being fetched by (org_id, size_variant_id), never searched on.
--
-- PHI: none. Product facts and staff attribution only.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."mask_variant_reviews"
  ADD COLUMN IF NOT EXISTS "source_kind" text;
--> statement-breakpoint

ALTER TABLE "resupply"."mask_variant_reviews"
  ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint

-- Constrain the class, not the pointer. Added separately and guarded so a
-- re-run against a database that already has the constraint is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mask_variant_reviews_source_kind_check'
  ) THEN
    ALTER TABLE "resupply"."mask_variant_reviews"
      ADD CONSTRAINT "mask_variant_reviews_source_kind_check"
      CHECK ("source_kind" IS NULL OR "source_kind" IN (
        'manufacturer_fit_guide',
        'manufacturer_spec_sheet',
        'physical_measurement',
        'clinical_judgment'
      ));
  END IF;
END $$;
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."mask_variant_reviews"."source_kind" IS
  'Class of evidence behind this sign-off. NULL for rows recorded before provenance capture existed.';
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."mask_variant_reviews"."source_ref" IS
  'Free-text pointer to the evidence: document title + revision, URL, or how it was measured.';
