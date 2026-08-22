-- 0514_for_her_size_bands — stop sizing "For Her" runs one physical
-- size down.
--
-- The defect
-- ----------
-- The "For Her" models are packaging variants sharing cushions with
-- their base model (docs/mask-size-run-registry-2026-08-21.md): the
-- AirFit F20 for Her ships the F20 cushion platform's XS/S/M, the
-- AirFit P10 for Her ships the P10 pillow platform's XS/S/M, and the
-- Mirage FX for Her ships one narrower cushion. 0511 banded each
-- For-Her run by partitioning the WHOLE population envelope across the
-- subset run — which shifted every code one physical size up:
--
--   f20-for-her  XS carried the platform S band, S carried the platform
--                M band, and M carried the platform L band (37.4-55 nw /
--                93.7-125 nc) — so a face the shared platform bands at L
--                was confidently dispensed the M cushion, inBand=true,
--                and the same face got DIFFERENT physical cushions from
--                the two model rows that ship identical hardware.
--   p10-for-her  M carried (approximately) the platform L band.
--   mirage-fx-for-her  the single "narrower" cushion was banded across
--                the full 20-55 envelope — wider than the base model's
--                own Standard cushion.
--
-- The fix
-- -------
-- Restate each For-Her run POSITIONALLY against its shared platform
-- ladder: the same physical cushion carries the same band on both model
-- rows, the XS below the platform S takes the platform ladder's
-- small-end XS shape (the derivation 0512 used for the F10/Quattro XS),
-- and the TOP of each subset run is deliberately NOT stretched to the
-- envelope ceiling. A face above the run's top scores out-of-band and
-- the engine's existing "closest available size — verify in person"
-- path fires (or a model that actually ships their size out-ranks it),
-- instead of a confident in-band recommendation of a cushion the
-- platform sizes one step small. catalog-bands.test.ts carries these
-- three runs in its TOP_OPEN_RUNS exemption for exactly that reason.
--
-- Everything stays fit_data_source='estimated',
-- needs_clinical_review=true; prior sign-offs on the three models are
-- deleted (they attested to bands that no longer exist) and
-- catalog_version is bumped — same mechanics as 0511/0512.
--
-- PHI: none. Product facts only.
--
-- Per ADR 003 — versioned hand-authored migration.

UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm"   = x."nw_min", "nose_width_max_mm"   = x."nw_max",
    "nose_height_min_mm"  = x."nh_min", "nose_height_max_mm"  = x."nh_max",
    "nose_to_chin_min_mm" = x."nc_min", "nose_to_chin_max_mm" = x."nc_max",
    "mouth_width_min_mm"  = x."mw_min", "mouth_width_max_mm"  = x."mw_max",
    "updated_at" = now()
FROM (VALUES
  -- resmed-airfit-f20-for-her (full_face, adult) — F20 cushion platform
  -- XS/S/M. S and M are the platform's own S and M bands (0511 lines for
  -- resmed-airfit-f20); XS takes the platform ladder's small-end shape.
  ('resmed-airfit-f20-for-her', 'cushion', 'XS', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('resmed-airfit-f20-for-her', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f20-for-her', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  -- resmed-airfit-p10-for-her (nasal_pillow, adult) — the P10 pillow
  -- platform's own XS/S/M bands, verbatim (same physical pillows).
  ('resmed-airfit-p10-for-her', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10-for-her', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10-for-her', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  -- resmed-mirage-fx-for-her (nasal, adult) — "a narrower Mirage FX
  -- cushion": at most the base model's own Standard band, not the whole
  -- envelope.
  ('resmed-mirage-fx-for-her', 'cushion', 'S', 20, 36.4, 18, 45, NULL, NULL, NULL, NULL)
) AS x("slug", "component", "size_code",
        "nw_min", "nw_max", "nh_min", "nh_max",
        "nc_min", "nc_max", "mw_min", "mw_max")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
WHERE v."mask_model_id" = m."id"
  AND v."component" = x."component"
  AND v."size_code" = x."size_code"
  AND v."status" = 'current';
--> statement-breakpoint

-- Prior sign-offs attested to millimetre ranges that no longer exist.
DELETE FROM "resupply"."mask_variant_reviews" r
USING "resupply"."mask_size_variants" v,
      "resupply"."mask_models" m
WHERE r."size_variant_id" = v."id"
  AND v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN (
  'resmed-airfit-f20-for-her',
  'resmed-airfit-p10-for-her',
  'resmed-mirage-fx-for-her'
);
--> statement-breakpoint

UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "org_id" IS NULL
  AND "slug" IN (
  'resmed-airfit-f20-for-her',
  'resmed-airfit-p10-for-her',
  'resmed-mirage-fx-for-her'
);
