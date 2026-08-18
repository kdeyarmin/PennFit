-- 0499_eson2_manufacturer_bands — the first manufacturer-sourced size bands.
--
-- What this is
-- ------------
-- Fisher & Paykel publish numeric seal-size ranges in "Mask Family Seal
-- Size Measurements", REF 620198. Three independently-hosted copies were
-- retrieved and compared (REV A 2020-04, REV B 2020-04, REV C 2020-08);
-- all three agree on the nasal figures, and REV C is the newest, so its
-- values are the ones used here. Converted cm -> mm:
--
--   Nose width    S: < 3.7 cm      M: 3.7-4.1 cm    L: > 4.1 cm
--   Nose height   S: < 4.4 cm      M: 4.4-5.2 cm    L: > 5.2 cm
--
-- This replaces the 0486 seed's ESTIMATES for Eson 2, and the divergence
-- is the point of doing it — the estimates were materially narrower and
-- shifted low:
--
--   size   estimated nose width   published nose width
--   S      26.5 - 32.1            up to 36.9
--   M      31.2 - 36.8            37.0 - 41.0
--   L      35.9 - 41.5            41.1 and above
--
-- A patient measuring 38 mm was being pointed at Large by the estimate
-- and is pointed at Medium by the manufacturer. Nose height was not
-- populated at all by 0486 (the seed's INSERT lists only width /
-- nose-to-chin / mouth), so this adds a dimension the engine could not
-- previously score on for this model.
--
-- Scope — deliberately three sizes of ONE model
-- ---------------------------------------------
-- REF 620198 names exactly three products: Eson 2, Simplus and Vitera.
-- It must NOT be applied to F&P's range at large: Evora Full ships
-- XS / S-M / L rather than S/M/L (per its own guide, REF 620938 REV A),
-- so a "family" table plainly does not describe every family member.
--
-- Of those three, only Eson 2 is imported. Simplus and Vitera are full
-- face, and REF 620198's full-face block gives a single measurement
-- (8.9 / 10 cm) whose column header does not appear in the document's
-- text layer next to the numbers — it could be nose-to-chin or a face
-- height measured differently. The estimates for those two diverge from
-- it substantially, so getting the mapping wrong would be worse than
-- leaving them alone. They stay 'estimated' pending a reviewer who can
-- look at the diagram.
--
-- Open-ended ranges
-- -----------------
-- The published S and L rows are unbounded ("less than", "greater
-- than"). `bandsFor` in lib/fitting/tiers.ts SKIPS a band with a NULL
-- endpoint, so an unbounded side would silently stop gating. The outer
-- edges therefore come from PLAUSIBILITY_BOUNDS in lib/fitting/
-- confidence.ts (noseWidth 20-60, noseHeight 25-70) — the window outside
-- which a measurement is already treated as a scan failure rather than a
-- small or large patient. Boundaries are tiled at 0.1 mm, the precision
-- the client rounds measurements to, so no value lands in two sizes and
-- none falls in a gap.
--
-- What this does NOT do
-- ---------------------
-- `needs_clinical_review` stays TRUE. Per 0495: a value transcribed from
-- a vendor document has not been checked by a clinician, and clearing the
-- flag centrally would lift the confidence ceiling for every tenant at
-- once, none of whom looked. The per-tenant RT sign-off remains the gate.
-- What changes is that the reviewer is now confirming a sourced value
-- instead of auditing an estimate, and 0495's citation columns give the
-- sign-off form something to pre-fill from.
--
-- Sourcing caveat, recorded because it affects how much weight to give
-- this: REF 620198 was not found on fphcare.com. Every copy retrieved was
-- reseller-hosted. F&P's own per-model guides (Vitera SUI-620483, Simplus
-- SUI-620495, Evora Full SUI-620938, Solo SUI-626078) are all printable
-- 1:1 templates with a calibration ruler and carry no numeric ranges.
-- Confirming the current revision with F&P directly is worth doing before
-- this data is leaned on hard.
--
-- Per ADR 003 — versioned hand-authored migration.

UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm"  = b."nw_min",
    "nose_width_max_mm"  = b."nw_max",
    "nose_height_min_mm" = b."nh_min",
    "nose_height_max_mm" = b."nh_max",
    -- `fit_data_source` is ROW-level, so every non-NULL band on the row
    -- inherits the citation below. The 0486 seed also estimated
    -- nose-to-chin and mouth width for these rows, and REF 620198 says
    -- nothing about either — leaving them would attribute an estimate to
    -- a document that does not contain it, and `scoreVariant` averages
    -- every non-NULL dimension, so a signed-off row could still be
    -- scoring on uncited numbers. Nasal sizing in the cited table is nose
    -- height and width; the rest is cleared rather than mislabelled.
    "nose_to_chin_min_mm" = NULL,
    "nose_to_chin_max_mm" = NULL,
    "mouth_width_min_mm"  = NULL,
    "mouth_width_max_mm"  = NULL,
    "fit_data_source"     = 'manufacturer',
    "fit_data_source_ref" =
      'Fisher & Paykel Mask Family Seal Size Measurements, REF 620198 REV C 2020-08 (nasal mask table)',
    "fit_data_source_date" = DATE '2020-08-01'
FROM (VALUES
  -- size, nose width min/max, nose height min/max (mm)
  ('S', 20.0, 36.9, 25.0, 43.9),
  ('M', 37.0, 41.0, 44.0, 52.0),
  ('L', 41.1, 60.0, 52.1, 70.0)
) AS b("size_code", "nw_min", "nw_max", "nh_min", "nh_max")
JOIN "resupply"."mask_models" m ON m."slug" = 'fisher-paykel-eson2'
WHERE v."mask_model_id" = m."id"
  AND v."component" = 'cushion'
  AND v."size_code" = b."size_code"
  -- Platform rows only. A tenant that added its own Eson 2 row owns that
  -- data and must not have it rewritten by a platform migration.
  AND m."org_id" IS NULL;
--> statement-breakpoint

-- Any existing sign-off attested to the OLD numbers.
--
-- `mask_variant_reviews` is keyed on `size_variant_id`, and this migration
-- rewrites the variant IN PLACE, so the UUID is unchanged and a tenant's
-- prior approval would carry straight over to materially different bands.
-- `catalog-store.ts` treats an approved row as clearing
-- `needs_clinical_review`, so that approval would ALSO lift the
-- high-confidence cap — for geometry nobody has looked at. Exactly the
-- outcome the review queue exists to prevent.
--
-- Deleted rather than flagged: the attestation named millimetre ranges
-- that no longer exist on the row, so keeping it would preserve a record
-- that points at nothing. The affected tenants return to the queue and
-- re-confirm, which is now a confirm-a-sourced-value job rather than an
-- audit.
--
-- In practice this is expected to delete nothing — the fitter flags ship
-- OFF and no tenant has worked the queue yet — but correctness here must
-- not depend on that being true.
DELETE FROM "resupply"."mask_variant_reviews" r
USING "resupply"."mask_size_variants" v,
      "resupply"."mask_models" m
WHERE r."size_variant_id" = v."id"
  AND v."mask_model_id" = m."id"
  AND m."slug" = 'fisher-paykel-eson2'
  AND m."org_id" IS NULL
  AND v."component" = 'cushion'
  AND v."size_code" IN ('S', 'M', 'L');
--> statement-breakpoint

-- Bump the catalog version so anything caching resolved geometry re-reads.
UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "slug" = 'fisher-paykel-eson2'
  AND "org_id" IS NULL;
