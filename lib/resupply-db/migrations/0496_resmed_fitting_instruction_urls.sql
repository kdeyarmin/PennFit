-- 0496_resmed_fitting_instruction_urls — link the RT to the manufacturer's
-- own fitting documentation.
--
-- Why
-- ---
-- 0481 gave `mask_models` a `fitting_instructions_url` (plus version
-- fields) "so a fit report can cite exactly which revision was in
-- force" — and the 0486 seed populated none of them. That empty column
-- is a real cost in the activation runbook: step A of
-- docs/runbooks/activate-clinical-fitter.md tells the reviewing RT to
-- "open that manufacturer's fitting guide", and today finding the guide
-- is the slowest part of every sign-off. With the URL on the model, the
-- catalog UI can render "open the manufacturer's fitting template" as
-- one click next to the sign-off form.
--
-- Scope — only documents actually verified
-- ----------------------------------------
-- Five ResMed models, each pointing at a ResMed-hosted document or
-- support hub that was individually confirmed to exist. This is a
-- starting set, not coverage: a URL nobody checked is worse than an
-- empty field, so models whose documentation was not verified stay NULL
-- and can be filled in follow-ups (or per-tenant preference — some of
-- these are regional editions, noted below, and a tenant may prefer its
-- own market's revision).
--
-- `fitting_instructions_version` is set only where the document itself
-- carries an identifier (the F40 user guide's document number);
-- `fitting_instructions_version_date` stays NULL throughout because no
-- revision date was captured — an uncaptured date is NULL, not a guess.
--
-- Sizing bands are NOT touched: every `mask_size_variants` row remains
-- 'estimated' and `needs_clinical_review = true`. This migration makes
-- the sign-off faster; it does not stand in for it.
--
-- Per ADR 003 — versioned hand-authored migration.

UPDATE "resupply"."mask_models" m
SET "fitting_instructions_url" = v."url",
    "fitting_instructions_version" = v."version",
    "catalog_version" = m."catalog_version" + 1,
    "updated_at" = now()
FROM (VALUES
  -- ResMed product guide, ROW English edition (includes the sizing guide).
  ('resmed-airfit-n20',
   'https://document.resmed.com/documents/products/mask/airfit-n20/product-guide/airfit-n20_product-guide_row_eng.pdf',
   NULL),
  -- ResMed user guide, AMER multi-language edition; 638415 is ResMed's
  -- own document number for this revision.
  ('resmed-airfit-f40',
   'https://document.resmed.com/documents/products/mask/airfit-f40/user-guide/638415_airfit-f40_user-guide_amer_multi.pdf',
   '638415 (AMER multi)'),
  -- ResMed patient information guides (maskguide.resmed.com).
  ('resmed-airfit-f30i',
   'https://maskguide.resmed.com/airfit-f30i',
   NULL),
  ('resmed-airfit-x30i',
   'https://maskguide.resmed.com/airfit-x30i',
   NULL),
  -- ResMed support hub for the magnet-free F20 SKU (en-GB edition — the
  -- page the SKU's existence was verified against).
  ('resmed-airfit-f20-non-magnetic',
   'https://support.resmed.com/en-gb/masks/airfit-f20-non-magnetic/',
   NULL)
) AS v("slug", "url", "version")
WHERE m."slug" = v."slug"
  AND m."org_id" IS NULL
  AND m."fitting_instructions_url" IS DISTINCT FROM v."url";
