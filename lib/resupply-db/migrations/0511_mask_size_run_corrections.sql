-- 0511_mask_size_run_corrections — the second wave of size-run fixes,
-- from manufacturer-grade sources.
--
-- 0510 corrected the seven ResMed size runs that could be verified
-- against ResMed's own storefront and flagged the rest as "checked
-- against retailer listings only … the obvious next pass". This is that
-- pass. Every change below reached either a manufacturer-hosted document
-- / manufacturer page or two independent consistent sources with
-- per-size SKUs; anything that did not stays untouched and is logged in
-- docs/mask-size-run-registry-2026-08-21.md.
--
-- What was wrong, per model
-- -------------------------
--   ResMed AirFit N10       seeded S/M/L; ResMed's own sizing brochure
--                           (doc 1018099) says "three cushion sizes:
--                           Small, Standard and Wide".
--   ResMed Swift FX Nano    seeded S/M/L; ships S / Standard / Wide
--                           (SKUs 62231 / 62230 / 62281).
--   ResMed Swift FX         seeded S/M/L; ships XS/S/M/L
--                           (SKUs 61520-61523).
--   ResMed AirFit F10 +     seeded S/M/L; the shared cushion ships
--   Quattro Air             XS/S/M/L (SKUs 62736-62739, "four cushion
--                           sizes", XS/S vs M/L frame pairing).
--   Philips Amara           seeded S/M/L/XL; ships Petite/S/M/L (gel
--                           SKUs 1090490/92/93/94; silicone the same
--                           four). The seed's run was shifted one whole
--                           size: its "M" default is the market's S.
--   Philips Wisp            seeded S/M/L; ships Petite / S-M / L / XL
--                           (SKUs 1094086 / 1094087 / 1094088 /
--                           1112031).
--   Philips Wisp Pediatric  seeded S/M; ships three child sizes S/M/L.
--   Philips TrueBlue        seeded P/S/M/L; ships five sizes — the MW
--                           between M and L was missing (SKUs
--                           1071861-1071865).
--   Philips ComfortGel Blue seeded S/M/L; ships S/M/L/XL (S and M share
--   Full                    a frame; L and XL have their own).
--   Philips FitLife         seeded S/L; ships S/L/XL. (Philips' own
--                           page mentions only S/L headgear; two
--                           retailers describe the mask in three sizes.)
--   Philips DreamWear Gel   seeded XS/S/M/L; Philips' own DreamWear
--   Pillows (dreamwear-np)  brochure: "Three cushion sizes (small,
--                           medium, large)". The XS never existed.
--   F&P Forma               seeded S/M/L; ships S/M/L/XL.
--   F&P Zest                seeded S/Standard/Plus; F&P's size names are
--                           Petite / Standard / Plus (400HC557/542/558).
--   Philips DreamWear Full  size CODE aligned: the seed stored
--   Face                    'MW (Medium Wide)' as the code itself, where
--                           every other Medium-Wide in the catalog (and
--                           the static fallback catalog) uses code 'MW'
--                           with the long form as the LABEL. Same size,
--                           same UUID — the code is what fit reports and
--                           order data carry, so the two catalog modes
--                           must agree on it.
--   F&P Brevida             codes restated as the manufacturer prints
--   F&P Evora Full          them: XS-S / M-L, and XS / S-M / L
--                           (Brevida fit-pack page; sizing guide REF
--                           620938). `size_code` is documented as "as
--                           the manufacturer prints it".
--
-- And one model that does not exist
-- --------------------------------
--   "DreamWear Full Face Gel" (philips-dreamwear-ff-gel). No such
--   Philips product could be found anywhere — not on Philips' site, not
--   at any retailer. The DreamWear line's gel option is the gel PILLOWS
--   cushion; there is no gel full-face variant. The model is retired
--   (status='discontinued'), which removes it from recommendation
--   (catalog-store loads current models only), and its variants are
--   retired with bands nulled. Rows are kept, not deleted — fit_sessions
--   and referrals hold plain foreign keys onto them.
--
-- Mechanics — same rules as 0510
-- ------------------------------
-- Renames happen IN PLACE so row UUIDs survive for formulary entries,
-- past fit sessions and referrals. The Amara rename is a CHAIN
-- (S->P, M->S, L->M, XL->L) executed as four sequential statements
-- because the unique index on (model, component, size_code) would
-- reject a transient duplicate inside one statement. Bands for every
-- touched model are restated on the final codes using the same
-- derivation as 0510 (canonical-face anchor, ±18% envelope, 10%
-- overlap, plausibility-window outer edges); a "wide" size shares its
-- base size's height band and steps up in width. Everything stays
-- fit_data_source='estimated', needs_clinical_review=true — a verified
-- SIZE RUN is not verified GEOMETRY. Prior sign-offs on touched models
-- are deleted (they attested to bands that no longer exist), and
-- catalog_version is bumped.
--
-- PHI: none. Product facts only.
--
-- Per ADR 003 — versioned hand-authored migration.


-- ---------------------------------------------------------------
-- 1. Retire "DreamWear Full Face Gel" — no such Philips product.
-- ---------------------------------------------------------------
UPDATE "resupply"."mask_models"
SET "status" = 'discontinued',
    "description" = 'Retired 2026-08-21: no Philips product by this name could be verified — the DreamWear line''s gel option is the gel pillows cushion, and no gel full-face variant exists. Kept for historical references only.',
    "updated_at" = now()
WHERE "slug" = 'philips-dreamwear-ff-gel' AND "org_id" IS NULL;
--> statement-breakpoint

UPDATE "resupply"."mask_size_variants" v
SET "status" = 'discontinued',
    "nose_width_min_mm" = NULL,  "nose_width_max_mm" = NULL,
    "nose_height_min_mm" = NULL, "nose_height_max_mm" = NULL,
    "nose_to_chin_min_mm" = NULL,"nose_to_chin_max_mm" = NULL,
    "mouth_width_min_mm" = NULL, "mouth_width_max_mm" = NULL,
    "face_width_min_mm" = NULL,  "face_width_max_mm" = NULL,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-dreamwear-ff-gel' AND m."org_id" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. The DreamWear Gel Pillows XS — a size Philips never made.
-- ---------------------------------------------------------------
-- Same retire-don't-delete rule as 0510 step 1.
UPDATE "resupply"."mask_size_variants" v
SET "status" = 'discontinued',
    "sort_order" = 900 + v."sort_order",
    "nose_width_min_mm" = NULL,  "nose_width_max_mm" = NULL,
    "nose_height_min_mm" = NULL, "nose_height_max_mm" = NULL,
    "nose_to_chin_min_mm" = NULL,"nose_to_chin_max_mm" = NULL,
    "mouth_width_min_mm" = NULL, "mouth_width_max_mm" = NULL,
    "face_width_min_mm" = NULL,  "face_width_max_mm" = NULL,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-dreamwear-np' AND m."org_id" IS NULL
  AND v."component" = 'pillow' AND v."size_code" = 'XS';
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. Amara: the whole run was shifted one size.
-- ---------------------------------------------------------------
-- Seeded S/M/L/XL maps positionally onto the real Petite/S/M/L, so each
-- row keeps its UUID and its place on the ladder while getting the code
-- the manufacturer prints. Four sequential statements — a single UPDATE
-- would transiently duplicate codes under the unique index.
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'P', "size_label" = 'P (Petite)', "sort_order" = 0,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-amara-full' AND m."org_id" IS NULL
  AND v."component" = 'cushion' AND v."size_code" = 'S';
--> statement-breakpoint
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'S', "size_label" = 'S', "sort_order" = 10,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-amara-full' AND m."org_id" IS NULL
  AND v."component" = 'cushion' AND v."size_code" = 'M';
--> statement-breakpoint
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'M', "size_label" = 'M', "sort_order" = 20,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-amara-full' AND m."org_id" IS NULL
  AND v."component" = 'cushion' AND v."size_code" = 'L';
--> statement-breakpoint
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'L', "size_label" = 'L', "sort_order" = 30,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-amara-full' AND m."org_id" IS NULL
  AND v."component" = 'cushion' AND v."size_code" = 'XL';
--> statement-breakpoint

-- The seeded default rode the rename from "M" down to "S"; the default a
-- fitter reaches for is the mid-run M (the old L row).
UPDATE "resupply"."mask_size_variants" v
SET "is_default" = (v."size_code" = 'M'), "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."slug" = 'philips-amara-full' AND m."org_id" IS NULL
  AND v."component" = 'cushion'
  AND v."is_default" IS DISTINCT FROM (v."size_code" = 'M');
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 4. Renames and ladder reorders (in place, UUIDs preserved).
-- ---------------------------------------------------------------
-- Includes no-op code renames that only restate sort_order — sizes
-- being inserted in step 5 need their place on the ladder.
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = x."new_code", "size_label" = x."new_label",
    "sort_order" = x."new_sort", "updated_at" = now()
FROM (VALUES
  ('fisher-paykel-brevida', 'pillow', 'XS/S', 'XS-S', 'XS-S', 0),
  ('fisher-paykel-brevida', 'pillow', 'M/L', 'M-L', 'M-L', 10),
  ('fisher-paykel-evora-full', 'cushion', 'S/M', 'S-M', 'S-M', 10),
  ('fisher-paykel-zest', 'cushion', 'S', 'Petite', 'Petite', 0),
  ('philips-dreamwear-ff', 'cushion', 'S', 'S', 'S', 0),
  ('philips-dreamwear-ff', 'cushion', 'M', 'M', 'M', 10),
  ('philips-dreamwear-ff', 'cushion', 'MW (Medium Wide)', 'MW', 'MW (Medium Wide)', 20),
  ('philips-dreamwear-ff', 'cushion', 'L', 'L', 'L', 30),
  ('philips-fitlife', 'cushion', 'L', 'L', 'L', 10),
  ('philips-trueblue', 'cushion', 'L', 'L', 'L', 40),
  ('philips-trueblue', 'cushion', 'M', 'M', 'M', 20),
  ('philips-trueblue', 'cushion', 'P', 'P', 'P', 0),
  ('philips-trueblue', 'cushion', 'S', 'S', 'S', 10),
  ('philips-wisp', 'cushion', 'S', 'P', 'P (Petite)', 0),
  ('philips-wisp', 'cushion', 'M', 'S/M', 'S/M', 10),
  ('philips-wisp', 'cushion', 'L', 'L', 'L', 20),
  ('philips-wisp-pediatric', 'cushion', 'S', 'S', 'S', 0),
  ('philips-wisp-pediatric', 'cushion', 'M', 'M', 'M', 10),
  ('resmed-airfit-f10', 'cushion', 'S', 'S', 'S', 10),
  ('resmed-airfit-f10', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-airfit-f10', 'cushion', 'L', 'L', 'L', 30),
  ('resmed-airfit-n10', 'cushion', 'M', 'Standard', 'Standard', 10),
  ('resmed-airfit-n10', 'cushion', 'L', 'Wide', 'Wide', 20),
  ('resmed-quattro-air', 'cushion', 'S', 'S', 'S', 10),
  ('resmed-quattro-air', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-quattro-air', 'cushion', 'L', 'L', 'L', 30),
  ('resmed-swift-fx', 'pillow', 'S', 'S', 'S', 10),
  ('resmed-swift-fx', 'pillow', 'M', 'M', 'M', 20),
  ('resmed-swift-fx', 'pillow', 'L', 'L', 'L', 30),
  ('resmed-swift-fx-nano', 'cushion', 'M', 'Standard', 'Standard', 10),
  ('resmed-swift-fx-nano', 'cushion', 'L', 'Wide', 'Wide', 20)
) AS x("slug", "component", "old_code", "new_code", "new_label", "new_sort")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
WHERE v."mask_model_id" = m."id"
  AND v."component" = x."component"
  AND v."size_code" = x."old_code";
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 5. Sizes the manufacturer ships that the seed never had.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_size_variants"
  ("mask_model_id", "component", "size_code", "size_label", "sort_order",
   "nose_width_min_mm", "nose_width_max_mm",
   "nose_height_min_mm", "nose_height_max_mm",
   "nose_to_chin_min_mm", "nose_to_chin_max_mm",
   "mouth_width_min_mm", "mouth_width_max_mm",
   "is_default", "hcpcs_code", "fit_data_source", "needs_clinical_review")
SELECT m."id", x."component", x."size_code", x."size_label", x."sort_order",
       x."nw_min", x."nw_max", x."nh_min", x."nh_max",
       x."nc_min", x."nc_max", x."mw_min", x."mw_max",
       false, x."hcpcs_code", 'estimated', true
FROM (VALUES
  ('resmed-swift-fx', 'pillow', 'XS', 'XS', 0,
   20, 32.8, NULL, NULL,
   NULL, NULL, NULL, NULL, 'A7033'),
  ('resmed-airfit-f10', 'cushion', 'XS', 'XS', 0,
   20, 32.8, NULL, NULL,
   55, 82.2, 30, 45.1, 'A7031'),
  ('resmed-quattro-air', 'cushion', 'XS', 'XS', 0,
   20, 32.8, NULL, NULL,
   55, 82.2, 30, 45.1, 'A7031'),
  ('philips-wisp', 'cushion', 'XL', 'XL', 30,
   38.6, 55, 31.7, 45,
   NULL, NULL, NULL, NULL, 'A7032'),
  ('philips-wisp-pediatric', 'cushion', 'L', 'L', 20,
   23, 55, 20.7, 45,
   NULL, NULL, NULL, NULL, 'A7032'),
  ('philips-trueblue', 'cushion', 'MW', 'MW (Medium Wide)', 30,
   38.6, 55, 29.1, 32.3,
   NULL, NULL, NULL, NULL, 'A7032'),
  ('philips-comfortgel-blue-full', 'cushion', 'XL', 'XL', 30,
   38.6, 55, NULL, NULL,
   96.6, 125, 53.1, 70, 'A7031'),
  ('philips-fitlife', 'cushion', 'XL', 'XL', 20,
   37.4, 55, NULL, NULL,
   93.7, 125, 51.5, 70, 'A7031'),
  ('fisher-paykel-forma', 'cushion', 'XL', 'XL', 30,
   38.6, 55, NULL, NULL,
   96.6, 125, 53.1, 70, 'A7031')
) AS x("slug", "component", "size_code", "size_label", "sort_order",
        "nw_min", "nw_max", "nh_min", "nh_max",
        "nc_min", "nc_max", "mw_min", "mw_max", "hcpcs_code")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "component", "size_code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 6. Bands for every touched model, restated on the final codes.
-- ---------------------------------------------------------------
-- Same derivation as 0510 section 3, re-run over the corrected runs.
UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm"   = x."nw_min", "nose_width_max_mm"   = x."nw_max",
    "nose_height_min_mm"  = x."nh_min", "nose_height_max_mm"  = x."nh_max",
    "nose_to_chin_min_mm" = x."nc_min", "nose_to_chin_max_mm" = x."nc_max",
    "mouth_width_min_mm"  = x."mw_min", "mouth_width_max_mm"  = x."mw_max",
    "updated_at" = now()
FROM (VALUES
  -- resmed-swift-fx (nasal_pillow, adult)
  ('resmed-swift-fx', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx', 'pillow', 'L', 38.6, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- resmed-airfit-f10 (full_face, adult)
  ('resmed-airfit-f10', 'cushion', 'XS', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('resmed-airfit-f10', 'cushion', 'S', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('resmed-airfit-f10', 'cushion', 'M', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('resmed-airfit-f10', 'cushion', 'L', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- resmed-quattro-air (full_face, adult)
  ('resmed-quattro-air', 'cushion', 'XS', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('resmed-quattro-air', 'cushion', 'S', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('resmed-quattro-air', 'cushion', 'M', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('resmed-quattro-air', 'cushion', 'L', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- resmed-airfit-n10 (nasal, adult)
  ('resmed-airfit-n10', 'cushion', 'S', 20, 34, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n10', 'cushion', 'Standard', 33.1, 38.3, 28.8, 45, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n10', 'cushion', 'Wide', 37.4, 55, 28.8, 45, NULL, NULL, NULL, NULL),
  -- resmed-swift-fx-nano (nasal, adult)
  ('resmed-swift-fx-nano', 'cushion', 'S', 20, 34, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx-nano', 'cushion', 'Standard', 33.1, 38.3, 28.8, 45, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx-nano', 'cushion', 'Wide', 37.4, 55, 28.8, 45, NULL, NULL, NULL, NULL),
  -- philips-amara-full (full_face, adult)
  ('philips-amara-full', 'cushion', 'P', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('philips-amara-full', 'cushion', 'S', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('philips-amara-full', 'cushion', 'M', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('philips-amara-full', 'cushion', 'L', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- philips-wisp (nasal, adult)
  ('philips-wisp', 'cushion', 'P', 20, 32.8, 18, 27, NULL, NULL, NULL, NULL),
  ('philips-wisp', 'cushion', 'S/M', 32.2, 36, 26.5, 29.6, NULL, NULL, NULL, NULL),
  ('philips-wisp', 'cushion', 'L', 35.4, 39.3, 29.1, 32.3, NULL, NULL, NULL, NULL),
  ('philips-wisp', 'cushion', 'XL', 38.6, 55, 31.7, 45, NULL, NULL, NULL, NULL),
  -- philips-wisp-pediatric (nasal, pediatric)
  ('philips-wisp-pediatric', 'cushion', 'S', 12, 18.3, 15, 18.3, NULL, NULL, NULL, NULL),
  ('philips-wisp-pediatric', 'cushion', 'M', 17.2, 24.1, 17.7, 21.4, NULL, NULL, NULL, NULL),
  ('philips-wisp-pediatric', 'cushion', 'L', 23, 55, 20.7, 45, NULL, NULL, NULL, NULL),
  -- philips-trueblue (nasal, adult)
  ('philips-trueblue', 'cushion', 'P', 20, 32.8, 18, 27, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'S', 32.2, 36, 26.5, 29.6, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'M', 35.4, 39.3, 29.1, 32.3, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'MW', 38.6, 55, 29.1, 32.3, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'L', 38.6, 55, 31.7, 45, NULL, NULL, NULL, NULL),
  -- philips-dreamwear-ff (full_face, adult)
  ('philips-dreamwear-ff', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-dreamwear-ff', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-dreamwear-ff', 'cushion', 'MW', 37.4, 55, NULL, NULL, 83, 95.8, 51.5, 70),
  ('philips-dreamwear-ff', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- philips-comfortgel-blue-full (full_face, adult)
  ('philips-comfortgel-blue-full', 'cushion', 'S', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('philips-comfortgel-blue-full', 'cushion', 'M', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('philips-comfortgel-blue-full', 'cushion', 'L', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('philips-comfortgel-blue-full', 'cushion', 'XL', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- philips-fitlife (total_face, adult)
  ('philips-fitlife', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-fitlife', 'cushion', 'L', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-fitlife', 'cushion', 'XL', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- philips-dreamwear-np (nasal_pillow, adult)
  ('philips-dreamwear-np', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-np', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-np', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- fisher-paykel-forma (full_face, adult)
  ('fisher-paykel-forma', 'cushion', 'S', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('fisher-paykel-forma', 'cushion', 'M', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('fisher-paykel-forma', 'cushion', 'L', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('fisher-paykel-forma', 'cushion', 'XL', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- fisher-paykel-zest (nasal, adult)
  ('fisher-paykel-zest', 'cushion', 'Petite', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-zest', 'cushion', 'Standard', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-zest', 'cushion', 'Plus', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- fisher-paykel-brevida (nasal_pillow, adult)
  ('fisher-paykel-brevida', 'pillow', 'XS-S', 20, 36.4, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-brevida', 'pillow', 'M-L', 35.1, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- fisher-paykel-evora-full (full_face, adult)
  ('fisher-paykel-evora-full', 'cushion', 'XS', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('fisher-paykel-evora-full', 'cushion', 'S-M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('fisher-paykel-evora-full', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70)
) AS x("slug", "component", "size_code",
        "nw_min", "nw_max", "nh_min", "nh_max",
        "nc_min", "nc_max", "mw_min", "mw_max")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
WHERE v."mask_model_id" = m."id"
  AND v."component" = x."component"
  AND v."size_code" = x."size_code"
  AND v."status" = 'current';
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 7. Invalidate sign-offs on touched models; bump catalog versions.
-- ---------------------------------------------------------------
-- Per 0510 section 5: the rows were rewritten in place, so a prior
-- approval would attest to millimetre ranges that no longer exist.
DELETE FROM "resupply"."mask_variant_reviews" r
USING "resupply"."mask_size_variants" v,
      "resupply"."mask_models" m
WHERE r."size_variant_id" = v."id"
  AND v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN (
  'fisher-paykel-brevida',
  'fisher-paykel-evora-full',
  'fisher-paykel-forma',
  'fisher-paykel-zest',
  'philips-amara-full',
  'philips-comfortgel-blue-full',
  'philips-dreamwear-ff',
  'philips-dreamwear-ff-gel',
  'philips-dreamwear-np',
  'philips-fitlife',
  'philips-trueblue',
  'philips-wisp',
  'philips-wisp-pediatric',
  'resmed-airfit-f10',
  'resmed-airfit-n10',
  'resmed-quattro-air',
  'resmed-swift-fx',
  'resmed-swift-fx-nano'
);
--> statement-breakpoint

UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "org_id" IS NULL
  AND "slug" IN (
  'fisher-paykel-brevida',
  'fisher-paykel-evora-full',
  'fisher-paykel-forma',
  'fisher-paykel-zest',
  'philips-amara-full',
  'philips-comfortgel-blue-full',
  'philips-dreamwear-ff',
  'philips-dreamwear-ff-gel',
  'philips-dreamwear-np',
  'philips-fitlife',
  'philips-trueblue',
  'philips-wisp',
  'philips-wisp-pediatric',
  'resmed-airfit-f10',
  'resmed-airfit-n10',
  'resmed-quattro-air',
  'resmed-swift-fx',
  'resmed-swift-fx-nano'
);
