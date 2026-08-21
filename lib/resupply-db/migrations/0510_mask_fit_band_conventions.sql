-- 0510_mask_fit_band_conventions — put every size band on the axis the
-- fitter actually measures.
--
-- The defect
-- ----------
-- `mask_size_variants` stores millimetre bands that are compared against
-- measurements the browser derives from MediaPipe landmarks. The two were
-- never on the same axis.
--
-- The pipeline measures `noseToChin` as **nose TIP (landmark 4) → menton
-- (152)**, frontally. On MediaPipe's canonical face model — the metric
-- reference mesh the landmark indices are defined against, and the
-- fixture `plausibility-windows.test.ts` pins `confidence.ts` to — that
-- span is **89.4 mm**, and `ADULT_PLAUSIBILITY_BOUNDS.noseToChin` is
-- [55, 125].
--
-- The 0486 seed's nose-to-chin bands are on a different scale: the
-- AirFit F20's whole size run spanned 54.5–80.5 mm, centred near 67.5,
-- which is the textbook **subnasale → menton** average rather than
-- anything this pipeline reports. (The seed cites no source, so the
-- convention is inferred from the values; what is not in doubt is that
-- they do not match landmarks 4 → 152.) An average adult therefore
-- measured ~22 mm ABOVE the largest F20 size and fell outside every
-- band. Three models (AirTouch F20, Simplus, Evora Full) were authored
-- on a third scale again, 88.7–131.3.
--
-- Ported `scoreVariant` against the shipped seed and the canonical face:
-- **42 of the 52 Fisher & Paykel / ResMed / Philips Respironics models
-- could not return a single in-band size for an average adult.** They
-- scored 0.67 with `inBand = false` — nose width and mouth width matched,
-- nose-to-chin could not — while the only models that DID come back
-- in-band were the ones carrying no nose-to-chin band at all. The failure
-- is silent and one-directional, exactly the shape `confidence.ts` warns
-- about: from the outside it looks like a patient with an unusual face,
-- not like a catalog on the wrong axis.
--
-- What this migration does
-- ------------------------
-- Re-derives every platform band from the pipeline's own calibration
-- constants rather than from textbook norms:
--
--   * anchor — the canonical face as THIS pipeline measures it
--     (nose width 35.72 · nose height 29.36 · nose-to-chin 89.40 ·
--     mouth width 49.12 mm);
--   * envelope — ±18% of that anchor, the ±3 SD population spread at
--     SD ≈ 6% of the mean that `plausibility-windows.test.ts` already
--     requires every window to clear;
--   * partition — the envelope split across the model's size run, each
--     bucket widened by 10% of its width so adjacent sizes overlap
--     rather than butt (the 0486 seed's own rule, kept);
--   * outer edges — the smallest and largest sizes run out to
--     `PLAUSIBILITY_BOUNDS`, so any measurement the pipeline still
--     accepts as a face lands in some size (the rule 0499 established
--     for Eson 2's open-ended published rows, now applied uniformly).
--
-- Which measurements gate which interface
-- ---------------------------------------
-- A NULL band means "this dimension does not gate this size", and the
-- engine skips it. The seed gated nasal masks and nasal pillows on
-- nose-to-chin and mouth width, which is not what sizes them:
--
--   full face / hybrid / total face  nose width · nose-to-chin · mouth width
--   nasal / nasal cradle             nose width · nose height
--   nasal pillow                     nose width
--
-- This follows 0499's precedent (it cleared nose-to-chin and mouth width
-- from Eson 2 because the cited nasal table says nothing about either)
-- and it matches how the one manufacturer who publishes numbers sizes its
-- range: Fisher & Paykel's "Mask Family Seal Size Measurements" (REF
-- 620198) gates nasal masks on nose height and nose width, and full face
-- masks on a vertical face span.
--
-- Wide sizes are not simply bigger
-- --------------------------------
-- "Small Wide" means a small nose height with a wider nose, so a wide
-- size shares its base size's height band and steps one bucket up in
-- width. The seed treated the AirFit N30i's run as the linear ladder
-- S < M < SW < W, which puts a small-wide patient two sizes off. The
-- step-up applies only where the run also carries the plain base size —
-- the AirFit F40 ships Small Wide / Medium / Large with no plain Small,
-- so it is an ordinary three-step ladder whose smallest size merely has
-- "wide" in its name.
--
-- Provenance — unchanged, deliberately
-- ------------------------------------
-- Every band written here stays `fit_data_source = 'estimated'` with
-- `needs_clinical_review = true`, and `fit_data_source_ref` stays NULL.
-- Nothing about this migration makes the numbers manufacturer data; it
-- makes them estimates of the right quantity instead of accurate
-- estimates of the wrong one. The per-tenant RT sign-off remains the
-- gate, and prior sign-offs are invalidated below because they attested
-- to millimetre ranges that no longer exist on the row.
--
-- Scope: platform rows only (`org_id IS NULL`). A tenant that authored
-- its own bands owns that data and is never rewritten by a platform
-- migration — but see the notice appended to
-- docs/mask-sizing-data-sources-2026-08-18.md: a tenant that authored
-- nose-to-chin bands against the old seed has the same defect and has to
-- re-derive them itself.
--
-- Held in place by
-- `artifacts/resupply-api/src/lib/fitting/catalog-bands.test.ts`, which
-- runs the real `scoreVariant` over the table below: an average adult
-- must find an in-band size on every adult mask, every band must sit
-- inside its population's plausibility window, and each size run must
-- tile that window at 0.1 mm with no gaps. Full audit, including what
-- the manufacturers do and do not publish, in
-- docs/mask-fit-band-audit-2026-08-21.md.
--
-- PHI: none. Product facts only.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- 1. Size codes the manufacturer never shipped.
-- ---------------------------------------------------------------
-- Each of these was invented by the 0486 seed. Verified against
-- ResMed's own storefront (eshop.resmed.com) and support pages:
-- AirFit F20 ships S/M/L, AirFit N20 S/M/L, AirFit F30 S/M only,
-- AirFit N30 S/SW/M, AirFit F30i S/SW/M/W.
--
-- Retired rather than DELETEd: `fit_sessions` carries plain (NO ACTION)
-- foreign keys onto `mask_size_variants`, so deleting a row a past
-- session recommended would fail the migration outright. `status` has
-- only 'current' | 'discontinued' to say this with, and `scoreFacialFit`
-- already skips a discontinued variant — so the row stops being
-- recommendable while every historical reference keeps resolving. The
-- bands are nulled at the same time: `scoreVariant` returns null for a
-- variant carrying no usable geometry, so even a caller that bypassed
-- the status filter could not score one of these into a recommendation.
UPDATE "resupply"."mask_size_variants" v
SET "status" = 'discontinued',
    -- Pushed past every live size so the admin catalog lists the run in
    -- the order the manufacturer prints it, with the retired rows last.
    "sort_order" = 900 + v."sort_order",
    "nose_width_min_mm" = NULL,  "nose_width_max_mm" = NULL,
    "nose_height_min_mm" = NULL, "nose_height_max_mm" = NULL,
    "nose_to_chin_min_mm" = NULL,"nose_to_chin_max_mm" = NULL,
    "mouth_width_min_mm" = NULL, "mouth_width_max_mm" = NULL,
    "face_width_min_mm" = NULL,  "face_width_max_mm" = NULL,
    "updated_at" = now()
FROM (VALUES
  ('resmed-airfit-f20', 'cushion', 'XS'),
  ('resmed-airfit-f20', 'cushion', 'LW (Large Wide)'),
  ('resmed-airfit-f30', 'cushion', 'Wide-S'),
  ('resmed-airfit-f30', 'cushion', 'Wide-M'),
  ('resmed-airfit-n20', 'cushion', 'XS'),
  ('resmed-airfit-n30', 'cushion', 'Wide-M'),
  ('resmed-airfit-f30i', 'cushion', 'L'),
  ('resmed-airfit-f30i', 'cushion', 'Wide-L'),
  ('resmed-airfit-f20-non-magnetic', 'cushion', 'XS'),
  ('resmed-airfit-f20-non-magnetic', 'cushion', 'LW (Large Wide)'),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'L'),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'Wide-L')
) AS x("slug", "component", "size_code")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
WHERE v."mask_model_id" = m."id"
  AND v."component" = x."component"
  AND v."size_code" = x."size_code";
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. Size codes the manufacturer prints differently.
-- ---------------------------------------------------------------
-- Renamed in place rather than deleted-and-reinserted so the row UUID
-- survives: a formulary entry, a past fit session or a provider referral
-- pointing at this size keeps resolving. `sort_order` is restated at the
-- same time because a wide size is NOT simply "bigger" — the AirFit N30i
-- ladder runs S, SW, M, W, and the seed's ordering put SW after M.
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = x."new_code",
    "size_label" = x."new_label",
    "sort_order" = x."new_sort",
    "updated_at" = now()
FROM (VALUES
  ('resmed-airfit-f30i', 'cushion', 'S', 'S', 'S', 0),
  ('resmed-airfit-f30i', 'cushion', 'Wide-S', 'SW', 'SW (Small Wide)', 10),
  ('resmed-airfit-f30i', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-airfit-f30i', 'cushion', 'Wide-M', 'W', 'W (Wide)', 30),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'S', 'S', 'S', 0),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'Wide-S', 'SW', 'SW (Small Wide)', 10),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'Wide-M', 'W', 'W (Wide)', 30),
  ('resmed-airfit-f40', 'cushion', 'S', 'SW', 'SW (Small Wide)', 0),
  ('resmed-airfit-n20', 'cushion', 'LW (Large Wide)', 'L', 'L', 30),
  ('resmed-airfit-n30', 'cushion', 'S', 'S', 'S', 0),
  ('resmed-airfit-n30', 'cushion', 'Wide-S', 'SW', 'SW (Small Wide)', 10),
  ('resmed-airfit-n30', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-airfit-n30i', 'cushion', 'S', 'S', 'S', 0),
  ('resmed-airfit-n30i', 'cushion', 'SW', 'SW', 'SW', 10),
  ('resmed-airfit-n30i', 'cushion', 'M', 'M', 'M', 20),
  ('resmed-airfit-n30i', 'cushion', 'W', 'W', 'W', 30)
) AS x("slug", "component", "old_code", "new_code", "new_label", "new_sort")
JOIN "resupply"."mask_models" m ON m."slug" = x."slug" AND m."org_id" IS NULL
WHERE v."mask_model_id" = m."id"
  AND v."component" = x."component"
  AND v."size_code" = x."old_code";
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. Every platform band, re-derived on the pipeline's conventions.
-- ---------------------------------------------------------------
-- Keyed on the POST-rename size code, so this runs after step 2.
-- `fit_data_source` stays 'estimated' and `needs_clinical_review` stays
-- true: this migration puts the estimates on the right axis, it does not
-- turn them into manufacturer data.
UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm"   = x."nw_min", "nose_width_max_mm"   = x."nw_max",
    "nose_height_min_mm"  = x."nh_min", "nose_height_max_mm"  = x."nh_max",
    "nose_to_chin_min_mm" = x."nc_min", "nose_to_chin_max_mm" = x."nc_max",
    "mouth_width_min_mm"  = x."mw_min", "mouth_width_max_mm"  = x."mw_max",
    "updated_at" = now()
FROM (VALUES
  -- Bleep Sleep bleep-dreamport (nasal_pillow, adult)
  ('bleep-dreamport', 'pillow', 'One size with adjustable ports', 20, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Bleep Sleep bleep-eclipse (nasal_pillow, adult)
  ('bleep-eclipse', 'pillow', 'Standard', 20, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Circadiance circadiance-sleepweaver-advance (nasal, adult)
  ('circadiance-sleepweaver-advance', 'cushion', 'Small', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('circadiance-sleepweaver-advance', 'cushion', 'Regular', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('circadiance-sleepweaver-advance', 'cushion', 'Large', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Circadiance circadiance-sleepweaver-advance-pediatric (nasal, pediatric)
  ('circadiance-sleepweaver-advance-pediatric', 'cushion', 'Pediatric', 12, 55, 15, 45, NULL, NULL, NULL, NULL),
  -- Circadiance circadiance-sleepweaver-anew (full_face, adult)
  ('circadiance-sleepweaver-anew', 'cushion', 'Regular', 20, 55, NULL, NULL, 55, 125, 30, 70),
  -- Circadiance circadiance-sleepweaver-elan (nasal, adult)
  ('circadiance-sleepweaver-elan', 'cushion', 'Regular', 20, 55, 18, 45, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-brevida (nasal_pillow, adult)
  ('fisher-paykel-brevida', 'pillow', 'XS/S', 20, 36.4, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-brevida', 'pillow', 'M/L', 35.1, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-eson (nasal, adult)
  ('fisher-paykel-eson', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-eson', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-eson', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-evora (nasal, adult)
  ('fisher-paykel-evora', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-evora', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-evora', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  ('fisher-paykel-evora', 'cushion', 'W', 37.4, 55, 27.2, 31.5, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-evora-full (full_face, adult)
  ('fisher-paykel-evora-full', 'cushion', 'XS', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('fisher-paykel-evora-full', 'cushion', 'S/M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('fisher-paykel-evora-full', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Fisher & Paykel fisher-paykel-forma (full_face, adult)
  ('fisher-paykel-forma', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('fisher-paykel-forma', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('fisher-paykel-forma', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Fisher & Paykel fisher-paykel-nova-micro (nasal_pillow, adult)
  ('fisher-paykel-nova-micro', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-nova-micro', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-nova-micro', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-opus-360 (nasal_pillow, adult)
  ('fisher-paykel-opus-360', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-opus-360', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-opus-360', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-pilairo-q (nasal_pillow, adult)
  ('fisher-paykel-pilairo-q', 'pillow', 'One Size', 20, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-simplus (full_face, adult)
  ('fisher-paykel-simplus', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('fisher-paykel-simplus', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('fisher-paykel-simplus', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Fisher & Paykel fisher-paykel-solo (nasal, adult)
  ('fisher-paykel-solo', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-solo', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-solo', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  ('fisher-paykel-solo', 'cushion', 'W', 37.4, 55, 27.2, 31.5, NULL, NULL, NULL, NULL),
  -- Fisher & Paykel fisher-paykel-vitera (full_face, adult)
  ('fisher-paykel-vitera', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('fisher-paykel-vitera', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('fisher-paykel-vitera', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Fisher & Paykel fisher-paykel-zest (nasal, adult)
  ('fisher-paykel-zest', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-zest', 'cushion', 'Standard', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-zest', 'cushion', 'Plus', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Hans Rudolph hans-rudolph-7600-v2 (full_face, adult)
  ('hans-rudolph-7600-v2', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('hans-rudolph-7600-v2', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('hans-rudolph-7600-v2', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Inogen inogen-aurora-f1 (full_face, adult)
  ('inogen-aurora-f1', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('inogen-aurora-f1', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('inogen-aurora-f1', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Inogen inogen-aurora-n1 (nasal, adult)
  ('inogen-aurora-n1', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('inogen-aurora-n1', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('inogen-aurora-n1', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Inogen inogen-aurora-p1 (nasal_pillow, adult)
  ('inogen-aurora-p1', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('inogen-aurora-p1', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('inogen-aurora-p1', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-amara-full (full_face, adult)
  ('philips-amara-full', 'cushion', 'S', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('philips-amara-full', 'cushion', 'M', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('philips-amara-full', 'cushion', 'L', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('philips-amara-full', 'cushion', 'XL', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- Philips Respironics philips-amara-view (full_face, adult)
  ('philips-amara-view', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-amara-view', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-amara-view', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Philips Respironics philips-comfortgel-blue-full (full_face, adult)
  ('philips-comfortgel-blue-full', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-comfortgel-blue-full', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-comfortgel-blue-full', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Philips Respironics philips-comfortgel-blue-nasal (nasal, adult)
  ('philips-comfortgel-blue-nasal', 'cushion', 'P', 20, 32.8, 18, 27, NULL, NULL, NULL, NULL),
  ('philips-comfortgel-blue-nasal', 'cushion', 'S', 32.2, 36, 26.5, 29.6, NULL, NULL, NULL, NULL),
  ('philips-comfortgel-blue-nasal', 'cushion', 'M', 35.4, 39.3, 29.1, 32.3, NULL, NULL, NULL, NULL),
  ('philips-comfortgel-blue-nasal', 'cushion', 'L', 38.6, 55, 31.7, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-dreamwear-ff (full_face, adult)
  ('philips-dreamwear-ff', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-dreamwear-ff', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-dreamwear-ff', 'cushion', 'MW (Medium Wide)', 37.4, 55, NULL, NULL, 83, 95.8, 51.5, 70),
  ('philips-dreamwear-ff', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Philips Respironics philips-dreamwear-ff-gel (hybrid, adult)
  ('philips-dreamwear-ff-gel', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-dreamwear-ff-gel', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-dreamwear-ff-gel', 'cushion', 'MW', 37.4, 55, NULL, NULL, 83, 95.8, 51.5, 70),
  ('philips-dreamwear-ff-gel', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Philips Respironics philips-dreamwear-nasal (nasal, adult)
  ('philips-dreamwear-nasal', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-nasal', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-nasal', 'cushion', 'MW', 37.4, 55, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-nasal', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-dreamwear-np (nasal_pillow, adult)
  ('philips-dreamwear-np', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-np', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-np', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-np', 'pillow', 'L', 38.6, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-dreamwear-silicone-pillows (nasal_pillow, adult)
  ('philips-dreamwear-silicone-pillows', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-silicone-pillows', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-silicone-pillows', 'pillow', 'MW', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-dreamwear-silicone-pillows', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-dreamwisp (nasal, adult)
  ('philips-dreamwisp', 'cushion', 'P', 20, 32.1, 18, 26.4, NULL, NULL, NULL, NULL),
  ('philips-dreamwisp', 'cushion', 'S', 31.6, 34.7, 26, 28.5, NULL, NULL, NULL, NULL),
  ('philips-dreamwisp', 'cushion', 'M', 34.2, 37.3, 28.1, 30.6, NULL, NULL, NULL, NULL),
  ('philips-dreamwisp', 'cushion', 'L', 36.7, 39.8, 30.2, 32.7, NULL, NULL, NULL, NULL),
  ('philips-dreamwisp', 'cushion', 'XL', 39.3, 55, 32.3, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-fitlife (total_face, adult)
  ('philips-fitlife', 'cushion', 'S', 20, 36.4, NULL, NULL, 55, 91, 30, 50),
  ('philips-fitlife', 'cushion', 'L', 35.1, 55, NULL, NULL, 87.8, 125, 48.2, 70),
  -- Philips Respironics philips-nuance-pro (nasal_pillow, adult)
  ('philips-nuance-pro', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-nuance-pro', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('philips-nuance-pro', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-performatrak-se (full_face, adult)
  ('philips-performatrak-se', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('philips-performatrak-se', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('philips-performatrak-se', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Philips Respironics philips-pico (nasal, adult)
  ('philips-pico', 'cushion', 'S/M', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('philips-pico', 'cushion', 'L', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('philips-pico', 'cushion', 'XL', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-trueblue (nasal, adult)
  ('philips-trueblue', 'cushion', 'P', 20, 32.8, 18, 27, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'S', 32.2, 36, 26.5, 29.6, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'M', 35.4, 39.3, 29.1, 32.3, NULL, NULL, NULL, NULL),
  ('philips-trueblue', 'cushion', 'L', 38.6, 55, 31.7, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-wisp (nasal, adult)
  ('philips-wisp', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('philips-wisp', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('philips-wisp', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Philips Respironics philips-wisp-pediatric (nasal, pediatric)
  ('philips-wisp-pediatric', 'cushion', 'S', 12, 21.5, 15, 20, NULL, NULL, NULL, NULL),
  ('philips-wisp-pediatric', 'cushion', 'M', 19.8, 55, 19.1, 45, NULL, NULL, NULL, NULL),
  -- Rain8 rain8-ameriflex-yf-01 (full_face, adult)
  ('rain8-ameriflex-yf-01', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('rain8-ameriflex-yf-01', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('rain8-ameriflex-yf-01', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Rain8 rain8-ameriflex-yf-02 (full_face, adult)
  ('rain8-ameriflex-yf-02', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('rain8-ameriflex-yf-02', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('rain8-ameriflex-yf-02', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Rain8 rain8-ameriflex-yn-02 (nasal, adult)
  ('rain8-ameriflex-yn-02', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yn-02', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yn-02', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Rain8 rain8-ameriflex-yn-03 (nasal, adult)
  ('rain8-ameriflex-yn-03', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yn-03', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yn-03', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Rain8 rain8-ameriflex-yp-01 (nasal_pillow, adult)
  ('rain8-ameriflex-yp-01', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yp-01', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('rain8-ameriflex-yp-01', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- React Health react-health-ivolve-f1a (full_face, adult)
  ('react-health-ivolve-f1a', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('react-health-ivolve-f1a', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('react-health-ivolve-f1a', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- React Health react-health-ivolve-n2 (nasal, adult)
  ('react-health-ivolve-n2', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-n2', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-n2', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- React Health react-health-ivolve-n3 (nasal, adult)
  ('react-health-ivolve-n3', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-n3', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-n3', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- React Health react-health-ivolve-p2 (nasal_pillow, adult)
  ('react-health-ivolve-p2', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-p2', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-p2', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-ivolve-p2', 'pillow', 'L', 38.6, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- React Health react-health-numa-full-face (full_face, adult)
  ('react-health-numa-full-face', 'cushion', 'S', 20, 32.8, NULL, NULL, 55, 82.2, 30, 45.1),
  ('react-health-numa-full-face', 'cushion', 'M', 32.2, 36, NULL, NULL, 80.5, 90.2, 44.3, 49.6),
  ('react-health-numa-full-face', 'cushion', 'L', 35.4, 39.3, NULL, NULL, 88.6, 98.3, 48.7, 54),
  ('react-health-numa-full-face', 'cushion', 'XL', 38.6, 55, NULL, NULL, 96.6, 125, 53.1, 70),
  -- React Health react-health-numa-pillow (nasal_pillow, adult)
  ('react-health-numa-pillow', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-numa-pillow', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-numa-pillow', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-numa-pillow', 'pillow', 'L', 38.6, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- React Health react-health-rio-ii (nasal_pillow, adult)
  ('react-health-rio-ii', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-rio-ii', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('react-health-rio-ii', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- React Health react-health-viva-nasal (nasal, adult)
  ('react-health-viva-nasal', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('react-health-viva-nasal', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('react-health-viva-nasal', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-f10 (full_face, adult)
  ('resmed-airfit-f10', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f10', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-f10', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airfit-f20 (full_face, adult)
  ('resmed-airfit-f20', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f20', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-f20', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airfit-f20-for-her (full_face, adult)
  ('resmed-airfit-f20-for-her', 'cushion', 'XS', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f20-for-her', 'cushion', 'S', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-f20-for-her', 'cushion', 'M', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airfit-f20-non-magnetic (full_face, adult)
  ('resmed-airfit-f20-non-magnetic', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f20-non-magnetic', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-f20-non-magnetic', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airfit-f30 (full_face, adult)
  ('resmed-airfit-f30', 'cushion', 'S', 20, 36.4, NULL, NULL, 55, 91, 30, 50),
  ('resmed-airfit-f30', 'cushion', 'M', 35.1, 55, NULL, NULL, 87.8, 125, 48.2, 70),
  -- ResMed resmed-airfit-f30i (hybrid, adult)
  ('resmed-airfit-f30i', 'cushion', 'S', 20, 34, NULL, NULL, 55, 91, 30, 46.8),
  ('resmed-airfit-f30i', 'cushion', 'SW', 33.1, 38.3, NULL, NULL, 55, 91, 45.6, 52.7),
  ('resmed-airfit-f30i', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 87.8, 125, 45.6, 52.7),
  ('resmed-airfit-f30i', 'cushion', 'W', 37.4, 55, NULL, NULL, 87.8, 125, 51.5, 70),
  -- ResMed resmed-airfit-f30i-non-magnetic (hybrid, adult)
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'S', 20, 34, NULL, NULL, 55, 91, 30, 46.8),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'SW', 33.1, 38.3, NULL, NULL, 55, 91, 45.6, 52.7),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 87.8, 125, 45.6, 52.7),
  ('resmed-airfit-f30i-non-magnetic', 'cushion', 'W', 37.4, 55, NULL, NULL, 87.8, 125, 51.5, 70),
  -- ResMed resmed-airfit-f40 (full_face, adult)
  ('resmed-airfit-f40', 'cushion', 'SW', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-f40', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-f40', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airfit-n10 (nasal, adult)
  ('resmed-airfit-n10', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n10', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n10', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-n20 (nasal, adult)
  ('resmed-airfit-n20', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n20', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n20', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-n30 (nasal, adult)
  ('resmed-airfit-n30', 'cushion', 'S', 20, 36.4, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n30', 'cushion', 'SW', 35.1, 55, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n30', 'cushion', 'M', 35.1, 55, 28.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-n30i (nasal, adult)
  ('resmed-airfit-n30i', 'cushion', 'S', 20, 34, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n30i', 'cushion', 'SW', 33.1, 38.3, 18, 29.9, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n30i', 'cushion', 'M', 33.1, 38.3, 28.8, 45, NULL, NULL, NULL, NULL),
  ('resmed-airfit-n30i', 'cushion', 'W', 37.4, 55, 28.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-p10 (nasal_pillow, adult)
  ('resmed-airfit-p10', 'pillow', 'XS', 20, 32.8, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10', 'pillow', 'S', 32.2, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10', 'pillow', 'M', 35.4, 39.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10', 'pillow', 'L', 38.6, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-p10-for-her (nasal_pillow, adult)
  ('resmed-airfit-p10-for-her', 'pillow', 'XS', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10-for-her', 'pillow', 'S', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p10-for-her', 'pillow', 'M', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-p30i (nasal_pillow, adult)
  ('resmed-airfit-p30i', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p30i', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-airfit-p30i', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- ResMed resmed-airfit-x30i (hybrid, adult)
  ('resmed-airfit-x30i', 'pillow', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airfit-x30i', 'pillow', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airfit-x30i', 'pillow', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airtouch-f20 (full_face, adult)
  ('resmed-airtouch-f20', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airtouch-f20', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airtouch-f20', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-airtouch-n20 (nasal, adult)
  ('resmed-airtouch-n20', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('resmed-airtouch-n20', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('resmed-airtouch-n20', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-mirage-fx (nasal, adult)
  ('resmed-mirage-fx', 'cushion', 'Standard', 20, 36.4, 18, 45, NULL, NULL, NULL, NULL),
  ('resmed-mirage-fx', 'cushion', 'Wide', 35.1, 55, 18, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-mirage-fx-for-her (nasal, adult)
  ('resmed-mirage-fx-for-her', 'cushion', 'S', 20, 55, 18, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-pixi (nasal, pediatric)
  ('resmed-pixi', 'cushion', 'Standard', 12, 55, 15, 45, NULL, NULL, NULL, NULL),
  -- ResMed resmed-quattro-air (full_face, adult)
  ('resmed-quattro-air', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-quattro-air', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-quattro-air', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-quattro-fx (full_face, adult)
  ('resmed-quattro-fx', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-quattro-fx', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-quattro-fx', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- ResMed resmed-swift-fx (nasal_pillow, adult)
  ('resmed-swift-fx', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- ResMed resmed-swift-fx-nano (nasal, adult)
  ('resmed-swift-fx-nano', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx-nano', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('resmed-swift-fx-nano', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- Sleepnet sleepnet-ascend (full_face, adult)
  ('sleepnet-ascend', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('sleepnet-ascend', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('sleepnet-ascend', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Sleepnet sleepnet-iq-2 (nasal, adult)
  ('sleepnet-iq-2', 'cushion', 'Standard', 20, 55, 18, 45, NULL, NULL, NULL, NULL),
  -- Sleepnet sleepnet-minime-2 (nasal, pediatric)
  ('sleepnet-minime-2', 'cushion', 'S', 12, 21.5, 15, 20, NULL, NULL, NULL, NULL),
  ('sleepnet-minime-2', 'cushion', 'M', 19.8, 55, 19.1, 45, NULL, NULL, NULL, NULL),
  -- Sleepnet sleepnet-mojo-2 (full_face, adult)
  ('sleepnet-mojo-2', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('sleepnet-mojo-2', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('sleepnet-mojo-2', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- Sleepnet sleepnet-veraseal-2 (full_face, adult)
  ('sleepnet-veraseal-2', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('sleepnet-veraseal-2', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('sleepnet-veraseal-2', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70)
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
-- 4. Eson 2 — keep the manufacturer nose width, drop the nose height.
-- ---------------------------------------------------------------
-- 0499 imported Fisher & Paykel REF 620198's nasal table and marked the
-- rows `fit_data_source = 'manufacturer'`. Its NOSE WIDTH column maps
-- cleanly: F&P measure "the widest part of the nose", which is the alar
-- span this pipeline reads at landmarks 129/358. Its NOSE HEIGHT column
-- does not. F&P's diagram measures from the bridge of the nose to just
-- BELOW the nose (≈ nasion → subnasale); the pipeline's `noseHeight` is
-- landmark 6 → landmark 4, bridge → nose TIP, which is ~29 mm on the
-- canonical face against F&P's 44–52 mm medium band.
--
-- Two consequences, both live today:
--   * `ADULT_PLAUSIBILITY_BOUNDS.noseHeight` is [18, 45] since the
--     windows were recalibrated against the canonical face. 0499 wrote
--     its open ends from the pre-calibration window (25–70), so Eson 2
--     Large (52.1–70.0) sits entirely above the ceiling and is
--     **unreachable**, and Medium (44.0–52.0) is reachable only across a
--     1 mm sliver.
--   * every plausible reading therefore resolves to Small.
--
-- The height bands are cleared rather than converted: the conversion
-- needs subnasale, which is not among the nine canonical vertices this
-- repository pins, and inventing its offset would be exactly the guess
-- 0499 refused to make for REF 620198's full-face column. The nose width
-- band is kept, with its open ends realigned from the old window to the
-- current one. The citation stays accurate — it now covers only the
-- column that was actually mappable.
UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm"  = b."nw_min",
    "nose_width_max_mm"  = b."nw_max",
    "nose_height_min_mm" = NULL,
    "nose_height_max_mm" = NULL,
    "fit_data_source_ref" =
      'Fisher & Paykel Mask Family Seal Size Measurements, REF 620198 '
      || 'REV C 2020-08 (nasal mask table, nose-width column only — the '
      || 'nose-height column is measured bridge-to-subnasale and does not '
      || 'map onto this pipeline''s bridge-to-tip nose height)',
    "updated_at" = now()
FROM (VALUES
  -- size, nose width min/max (mm). Open ends from
  -- ADULT_PLAUSIBILITY_BOUNDS.noseWidth = [20, 55]; interior boundaries
  -- tile at 0.1 mm, the precision the client rounds to.
  ('S', 20.0, 36.9),
  ('M', 37.0, 41.0),
  ('L', 41.1, 55.0)
) AS b("size_code", "nw_min", "nw_max")
JOIN "resupply"."mask_models" m ON m."slug" = 'fisher-paykel-eson2'
WHERE v."mask_model_id" = m."id"
  AND v."component" = 'cushion'
  AND v."size_code" = b."size_code"
  AND m."org_id" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 5. Invalidate sign-offs that attested to the old numbers.
-- ---------------------------------------------------------------
-- Same reasoning as 0499: `mask_variant_reviews` is keyed on
-- `size_variant_id` and every row above was rewritten IN PLACE, so a
-- tenant's prior approval would carry over to materially different
-- bands. `catalog-store.ts` treats an approved row as clearing
-- `needs_clinical_review`, so that approval would also lift the
-- high-confidence cap for geometry nobody has looked at.
--
-- Deleted rather than flagged: the attestation named millimetre ranges
-- that no longer exist on the row, so keeping it would preserve a record
-- pointing at nothing. Affected tenants return to the queue.
DELETE FROM "resupply"."mask_variant_reviews" r
USING "resupply"."mask_size_variants" v,
      "resupply"."mask_models" m
WHERE r."size_variant_id" = v."id"
  AND v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND v."component" IN ('cushion', 'pillow');
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 6. Bump the catalog version so cached geometry is re-read.
-- ---------------------------------------------------------------
UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "org_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "resupply"."mask_size_variants" v
    WHERE v."mask_model_id" = "resupply"."mask_models"."id"
      AND v."component" IN ('cushion', 'pillow')
  );
