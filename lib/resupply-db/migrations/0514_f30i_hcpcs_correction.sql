-- 0514_f30i_hcpcs_correction — the AirFit F30i is a full-face mask, not
-- a combination oral/nasal one.
--
-- The 0486 seed coded the F30i's cushions A7028 and frames A7027 — the
-- HCPCS family for COMBINATION oral/nasal masks (whose Medicare exemplar
-- is the Mirage Liberty). ResMed's own HCPCS reference card (document
-- 101837) lists the AirFit F30i under A7030 (full face mask used with
-- positive airway pressure device) and A7031 (face mask interface,
-- replacement for full face mask) — the same coding the architecturally
-- identical DreamWear Full Face already carries in the same seed. The
-- 0493 magnet-free twin copied the wrong codes verbatim.
--
-- The interval difference is real (A7028 allows 2 per 30 days, A7031
-- one per month), though on current code neither resupply cadence nor
-- claims derive from `mask_size_variants.hcpcs_code` — cadence resolves
-- through the sku_hcpcs_map prefix layer. This corrects the reference
-- data before anything new starts reading it.
--
-- "philips-dreamwear-ff-gel" carried the same miscoding but was retired
-- outright by 0512 (no such product); its rows are historical and stay
-- untouched.
--
-- PHI: none. Product facts only.
--
-- Per ADR 003 — versioned hand-authored migration.

UPDATE "resupply"."mask_size_variants" v
SET "hcpcs_code" = CASE v."component"
      WHEN 'frame' THEN 'A7030'
      ELSE 'A7031'
    END,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic')
  AND v."hcpcs_code" IN ('A7027', 'A7028');
--> statement-breakpoint

UPDATE "resupply"."mask_components" c
SET "hcpcs_code" = CASE c."component_type"
      WHEN 'frame' THEN 'A7030'
      ELSE 'A7031'
    END,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE c."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic')
  AND c."hcpcs_code" IN ('A7027', 'A7028');
--> statement-breakpoint

UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "org_id" IS NULL
  AND "slug" IN ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic');
