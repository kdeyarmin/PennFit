-- 0495_variant_fit_data_provenance — cite the source behind a platform band.
--
-- Why
-- ---
-- 0491 gave the TENANT side of the review model provenance: a sign-off in
-- `mask_variant_reviews` can now say what document it was checked
-- against. The PLATFORM side still cannot. `mask_size_variants` carries
-- `fit_data_source` ('manufacturer' | 'measured' | 'estimated') but has
-- nowhere to record WHICH manufacturer document or measurement a
-- non-estimated band came from — so the moment anyone upgrades a band
-- from 'estimated', the claim becomes uncheckable.
--
-- These two columns close that, and the CHECK constraint is the point of
-- the whole migration: it makes claiming manufacturer or measured
-- provenance WITHOUT a citation structurally impossible, rather than a
-- policy someone has to remember. Every existing row is 'estimated', so
-- the constraint validates instantly against the current catalog.
--
-- What this deliberately does NOT do
-- ---------------------------------
-- It does not upgrade any band, and nothing in this workstream clears
-- `needs_clinical_review`. That flag means "no clinician has checked
-- these numbers", and a value transcribed from a vendor page has not
-- been checked by a clinician — clearing it centrally would lift the
-- confidence ceiling for every tenant at once, none of whom looked. The
-- per-tenant RT sign-off (0482/0491) stays the gate; what this migration
-- changes is that when real data DOES land, it lands with a citation the
-- sign-off UI can pre-fill from, turning "audit an estimate" into
-- "confirm a sourced value".
--
-- NULL semantics: ref and date are NULL on an 'estimated' band because
-- there is nothing to cite — never "we forgot". A URL that merely
-- INFORMED an estimate belongs in the ref with the source left
-- 'estimated'; the constraint only binds the non-estimated direction.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."mask_size_variants"
  ADD COLUMN IF NOT EXISTS "fit_data_source_ref" text;
--> statement-breakpoint

ALTER TABLE "resupply"."mask_size_variants"
  ADD COLUMN IF NOT EXISTS "fit_data_source_date" date;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mask_size_variants_source_ref_required_check'
  ) THEN
    ALTER TABLE "resupply"."mask_size_variants"
      ADD CONSTRAINT "mask_size_variants_source_ref_required_check"
      CHECK (
        "fit_data_source" = 'estimated'
        OR "fit_data_source_ref" IS NOT NULL
      );
  END IF;
END $$;
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."mask_size_variants"."fit_data_source_ref" IS
  'What this band was sourced from: document title + revision, URL, or how it was physically measured. Required whenever fit_data_source is not ''estimated''; NULL on an estimated band means "nothing to cite", never "unrecorded".';
--> statement-breakpoint

COMMENT ON COLUMN "resupply"."mask_size_variants"."fit_data_source_date" IS
  'Date of the cited document revision, or of the measurement. NULL when the source carries no date.';
