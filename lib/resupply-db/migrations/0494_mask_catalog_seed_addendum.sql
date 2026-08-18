-- 0494_mask_catalog_seed_addendum — Inogen Aurora, Rain8 AmeriFlex, AirFit X30i.
--
-- Why
-- ---
-- The SleepGlad formulary comparison (docs/competitor-analysis-sleepglad-
-- 2026-08-18.md) found three manufacturers their formulary carries that
-- ours does not, plus one ResMed model. This addendum seeds the ones that
-- could be verified against real product listings:
--
--   Inogen Aurora    F1 (full face), N1 (nasal), P1 (nasal pillows) —
--                    launched Jan 2026, FDA-cleared. Inogen's launch
--                    materials state all three are "constructed without
--                    magnetic headgear clips" — a deliberate post-recall
--                    position, which makes them exactly the class of mask
--                    the magnet safety screen should be able to offer.
--   Rain8 AmeriFlex  YF-01 / YF-02 (full face, 3- and 4-point headgear),
--                    YN-02 / YN-03 (nasal, 3- and 4-point), YP-01 (nasal
--                    pillows). Retailer listings confirm the model codes
--                    and the S/M/L size runs. Strap-mounted headgear; no
--                    magnets advertised anywhere in the product line.
--   ResMed AirFit X30i  Hybrid: nasal pillows plus an under-mouth oral
--                    cushion, top-of-head tube. Pillows S/M/L, frame
--                    Small/Standard/Large, one-size oral cushion.
--                    HAS MAGNETIC HEADGEAR CLIPS (ResMed's own product
--                    and support pages), so it is seeded with the same
--                    magnet_implant_* exclusions as the rest of ResMed's
--                    magnetic family.
--
-- Deliberately NOT seeded: Genadyne. SleepGlad lists a "Genadyne Nasal
-- Cradle Mask", but no primary source for the model's name, sizes, or
-- interface details could be found — and inventing model rows in a
-- clinical catalog is worse than the gap. Add it when a manufacturer
-- catalog or spec sheet can be cited.
--
-- Data posture — same as 0486, stated again because it matters
-- ------------------------------------------------------------
-- Every size band below is an ESTIMATE: the class-generic bands this seed
-- already uses for the same interface type (full-face bands from the
-- iVolve F1A row set, nasal from iVolve N2, pillows from AirFit P30i).
-- Every row lands fit_data_source='estimated', needs_clinical_review=true,
-- and the engine caps an unreviewed variant below high confidence. For the
-- Aurora masks the SIZE RUN ITSELF (S/M/L) is also assumed — Inogen has
-- not published one — so the sign-off step must verify not just the bands
-- but that each size exists before approving. Unverifiable model facts
-- (weight, pressure range) are NULL, which the engine treats as "skip the
-- check", never as a value.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO "resupply"."mask_models"
  ("org_id", "slug", "manufacturer", "model_name", "product_line",
   "interface_type", "service_line", "therapy_modes", "vented",
   "has_magnetic_components", "magnetic_component_notes",
   "pressure_min_cm_h2o", "pressure_max_cm_h2o", "minimal_contact",
   "avoids_nasal_bridge",
   "hose_position", "facial_hair_tolerance", "side_sleeping_tolerance",
   "claustrophobia_tolerance", "glasses_compatible", "cushion_material",
   "headgear_style", "weight_grams", "description", "status",
   "successor_slug", "fit_data_source", "needs_clinical_review")
VALUES
  (NULL, 'inogen-aurora-f1', 'Inogen', 'Aurora F1', 'Aurora',
   'full_face', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'poor', 'good',
   'poor', false, 'Silicone',
   'Crown-style with quick-release clips', NULL, 'Full face mask with an adaptive medical-grade rebound silicone cushion, crown-style headgear and quiet honeycomb venting. No magnetic headgear clips — safe alongside implanted medical devices.', 'current',
   NULL, 'estimated', true),
  (NULL, 'inogen-aurora-n1', 'Inogen', 'Aurora N1', 'Aurora',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'fair', 'fair',
   'good', false, 'Silicone',
   'Soft fabric with quick-release clips', NULL, 'Streamlined nasal mask with a medical-grade rebound silicone cushion and quiet honeycomb venting, built for a lighter, more minimal feel. No magnetic headgear clips.', 'current',
   NULL, 'estimated', true),
  (NULL, 'inogen-aurora-p1', 'Inogen', 'Aurora P1', 'Aurora',
   'nasal_pillow', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, true,
   true,
   'front', 'good', 'good',
   'good', true, 'Silicone',
   'Soft fabric with quick-release clips', NULL, 'Compact nasal pillows mask with a silicone cushion, quiet honeycomb venting and a 360-degree swivel elbow that accommodates movement during sleep. No magnetic headgear clips.', 'current',
   NULL, 'estimated', true),
  (NULL, 'rain8-ameriflex-yf-01', 'Rain8', 'AmeriFlex YF-01', 'AmeriFlex Comfort Series',
   'full_face', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'poor', 'good',
   'poor', false, 'Silicone',
   '3-point strap headgear', NULL, 'Full face mask with a three-point strap mounting system, Seal-Tight silicone cushion and an ultra-quiet honeycomb vent structure.', 'current',
   NULL, 'estimated', true),
  (NULL, 'rain8-ameriflex-yf-02', 'Rain8', 'AmeriFlex YF-02', 'AmeriFlex Comfort Series',
   'full_face', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'poor', 'good',
   'poor', false, 'Silicone',
   '4-point strap headgear', NULL, 'Full face mask with a four-point mounting system and Ultra-Comfort Seal-Tight silicone cushion for a more distributed, stable fit.', 'current',
   NULL, 'estimated', true),
  (NULL, 'rain8-ameriflex-yn-02', 'Rain8', 'AmeriFlex YN-02', 'AmeriFlex Comfort Series',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'fair', 'fair',
   'good', false, 'Silicone',
   '3-point strap headgear', NULL, 'Nasal mask with a three-point mounting system and Adaptive Easy Flex silicone cushion that seals without over-tightening.', 'current',
   NULL, 'estimated', true),
  (NULL, 'rain8-ameriflex-yn-03', 'Rain8', 'AmeriFlex YN-03', 'AmeriFlex Comfort Series',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, false,
   false,
   'front', 'fair', 'fair',
   'good', false, 'Silicone',
   '4-point strap headgear', NULL, 'Nasal mask with a four-point mounting system for a comfortable seal with an open field of view.', 'current',
   NULL, 'estimated', true),
  (NULL, 'rain8-ameriflex-yp-01', 'Rain8', 'AmeriFlex YP-01', 'AmeriFlex Comfort Series',
   'nasal_pillow', 'adult', ARRAY['pap']::text[], 'vented',
   false, NULL,
   NULL, NULL, true,
   true,
   'front', 'good', 'good',
   'good', true, 'Silicone',
   'Soft fabric strap headgear', NULL, 'Nasal pillows mask in the AmeriFlex Comfort Series, with the line''s Adaptive Easy Flex silicone and quiet honeycomb venting.', 'current',
   NULL, 'estimated', true),
  (NULL, 'resmed-airfit-x30i', 'ResMed', 'AirFit X30i', NULL,
   'hybrid', 'adult', ARRAY['pap']::text[], 'vented',
   true, 'Magnetic headgear clips. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.',
   4, 25, true,
   true,
   'top', 'good', 'good',
   'good', true, 'Silicone',
   'Soft fabric with magnetic clips', NULL, 'Hybrid mask pairing nasal pillows with an under-mouth oral cushion and a top-of-head tube connection. Covers mouth breathing without touching the nasal bridge, and the tube-up frame suits side sleepers.', 'current',
   NULL, 'estimated', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."mask_size_variants"
  ("mask_model_id", "component", "size_code", "size_label", "sort_order",
   "nose_width_min_mm", "nose_width_max_mm",
   "nose_to_chin_min_mm", "nose_to_chin_max_mm",
   "mouth_width_min_mm", "mouth_width_max_mm",
   "is_default", "hcpcs_code", "fit_data_source", "needs_clinical_review")
SELECT m."id", v."component", v."size_code", v."size_label", v."sort_order",
       v."nw_min", v."nw_max", v."nc_min", v."nc_max", v."mw_min", v."mw_max",
       v."is_default", v."hcpcs_code", 'estimated', true
FROM (VALUES
  -- Full-face class-generic estimated bands (same values as the iVolve
  -- F1A rows in 0486 — one shared clinically-reasoned default per class).
  ('inogen-aurora-f1', 'cushion', 'S', 'S', 0,
   27.5, 33.9, 53.1, 63.5, 40.4, 48.0,
   false, 'A7031'),
  ('inogen-aurora-f1', 'cushion', 'M', 'M', 10,
   32.8, 39.2, 61.8, 72.2, 46.7, 54.3,
   true, 'A7031'),
  ('inogen-aurora-f1', 'cushion', 'L', 'L', 20,
   38.1, 44.5, 70.5, 80.9, 53.0, 60.6,
   false, 'A7031'),
  ('rain8-ameriflex-yf-01', 'cushion', 'S', 'S', 0,
   27.5, 33.9, 53.1, 63.5, 40.4, 48.0,
   false, 'A7031'),
  ('rain8-ameriflex-yf-01', 'cushion', 'M', 'M', 10,
   32.8, 39.2, 61.8, 72.2, 46.7, 54.3,
   true, 'A7031'),
  ('rain8-ameriflex-yf-01', 'cushion', 'L', 'L', 20,
   38.1, 44.5, 70.5, 80.9, 53.0, 60.6,
   false, 'A7031'),
  ('rain8-ameriflex-yf-02', 'cushion', 'S', 'S', 0,
   27.5, 33.9, 53.1, 63.5, 40.4, 48.0,
   false, 'A7031'),
  ('rain8-ameriflex-yf-02', 'cushion', 'M', 'M', 10,
   32.8, 39.2, 61.8, 72.2, 46.7, 54.3,
   true, 'A7031'),
  ('rain8-ameriflex-yf-02', 'cushion', 'L', 'L', 20,
   38.1, 44.5, 70.5, 80.9, 53.0, 60.6,
   false, 'A7031'),
  -- Nasal class-generic estimated bands (iVolve N2 values).
  ('inogen-aurora-n1', 'cushion', 'S', 'S', 0,
   26.5, 32.5, 44.1, 54.9, 35.3, 43.3,
   false, 'A7032'),
  ('inogen-aurora-n1', 'cushion', 'M', 'M', 10,
   31.5, 37.5, 53.1, 63.9, 42.0, 50.0,
   true, 'A7032'),
  ('inogen-aurora-n1', 'cushion', 'L', 'L', 20,
   36.5, 42.5, 62.1, 72.9, 48.7, 56.7,
   false, 'A7032'),
  ('rain8-ameriflex-yn-02', 'cushion', 'S', 'S', 0,
   26.5, 32.5, 44.1, 54.9, 35.3, 43.3,
   false, 'A7032'),
  ('rain8-ameriflex-yn-02', 'cushion', 'M', 'M', 10,
   31.5, 37.5, 53.1, 63.9, 42.0, 50.0,
   true, 'A7032'),
  ('rain8-ameriflex-yn-02', 'cushion', 'L', 'L', 20,
   36.5, 42.5, 62.1, 72.9, 48.7, 56.7,
   false, 'A7032'),
  ('rain8-ameriflex-yn-03', 'cushion', 'S', 'S', 0,
   26.5, 32.5, 44.1, 54.9, 35.3, 43.3,
   false, 'A7032'),
  ('rain8-ameriflex-yn-03', 'cushion', 'M', 'M', 10,
   31.5, 37.5, 53.1, 63.9, 42.0, 50.0,
   true, 'A7032'),
  ('rain8-ameriflex-yn-03', 'cushion', 'L', 'L', 20,
   36.5, 42.5, 62.1, 72.9, 48.7, 56.7,
   false, 'A7032'),
  -- Nasal-pillow class-generic estimated bands (AirFit P30i values).
  ('inogen-aurora-p1', 'pillow', 'S', 'S', 0,
   19.5, 25.9, 34.0, 46.0, 29.3, 37.3,
   false, 'A7033'),
  ('inogen-aurora-p1', 'pillow', 'M', 'M', 10,
   24.8, 31.2, 44.0, 56.0, 36.0, 44.0,
   true, 'A7033'),
  ('inogen-aurora-p1', 'pillow', 'L', 'L', 20,
   30.1, 36.5, 54.0, 66.0, 42.7, 50.7,
   false, 'A7033'),
  ('rain8-ameriflex-yp-01', 'pillow', 'S', 'S', 0,
   19.5, 25.9, 34.0, 46.0, 29.3, 37.3,
   false, 'A7033'),
  ('rain8-ameriflex-yp-01', 'pillow', 'M', 'M', 10,
   24.8, 31.2, 44.0, 56.0, 36.0, 44.0,
   true, 'A7033'),
  ('rain8-ameriflex-yp-01', 'pillow', 'L', 'L', 20,
   30.1, 36.5, 54.0, 66.0, 42.7, 50.7,
   false, 'A7033'),
  -- X30i: pillows sized S/M/L (combination-mask pillows bill A7029, which
  -- resupply.hcpcs_codes already carries); frame Small/Standard/Large with
  -- no facial bands of its own, same shape as the P30i frame rows.
  ('resmed-airfit-x30i', 'pillow', 'S', 'S', 0,
   19.5, 25.9, 34.0, 46.0, 29.3, 37.3,
   false, 'A7029'),
  ('resmed-airfit-x30i', 'pillow', 'M', 'M', 10,
   24.8, 31.2, 44.0, 56.0, 36.0, 44.0,
   true, 'A7029'),
  ('resmed-airfit-x30i', 'pillow', 'L', 'L', 20,
   30.1, 36.5, 54.0, 66.0, 42.7, 50.7,
   false, 'A7029'),
  ('resmed-airfit-x30i', 'frame', 'S', 'Small', 0,
   NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7027'),
  ('resmed-airfit-x30i', 'frame', 'STD', 'Standard', 10,
   NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7027'),
  ('resmed-airfit-x30i', 'frame', 'L', 'Large', 20,
   NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7027')
) AS v("slug", "component", "size_code", "size_label", "sort_order",
       "nw_min", "nw_max", "nc_min", "nc_max", "mw_min", "mw_max",
       "is_default", "hcpcs_code")
JOIN "resupply"."mask_models" m
  ON m."slug" = v."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "component", "size_code") DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."mask_contraindications"
  ("mask_model_id", "factor", "severity", "rationale", "source")
SELECT m."id", c."factor", c."severity", c."rationale", c."source"
FROM (VALUES
  -- Full face: the standard soft cautions, worded identically to 0486.
  ('inogen-aurora-f1', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('inogen-aurora-f1', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  ('rain8-ameriflex-yf-01', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('rain8-ameriflex-yf-01', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  ('rain8-ameriflex-yf-02', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('rain8-ameriflex-yf-02', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  -- Nasal and pillow interfaces: the standard airway cautions.
  ('inogen-aurora-n1', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('inogen-aurora-n1', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('rain8-ameriflex-yn-02', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('rain8-ameriflex-yn-02', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('rain8-ameriflex-yn-03', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('rain8-ameriflex-yn-03', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('inogen-aurora-p1', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('inogen-aurora-p1', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('rain8-ameriflex-yp-01', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('rain8-ameriflex-yp-01', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  -- X30i carries magnets: same hard exclusions as the rest of ResMed's
  -- magnetic family. From the manufacturer's own user guide (not the FDA
  -- recall list, which predates this model), hence no version_date.
  ('resmed-airfit-x30i', 'magnet_implant_patient', 'exclude', 'The headgear clips contain magnets, which can interfere with implanted medical devices such as pacemakers, defibrillators, aneurysm clips, cochlear implants, and adjustable shunt valves.', 'manufacturer_ifu'),
  ('resmed-airfit-x30i', 'magnet_implant_household', 'exclude', 'The headgear magnets pose the same interference risk to a household member with an implanted device who handles the mask or sleeps beside the wearer.', 'manufacturer_ifu')
) AS c("slug", "factor", "severity", "rationale", "source")
JOIN "resupply"."mask_models" m
  ON m."slug" = c."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "factor") DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."mask_components"
  ("mask_model_id", "component_type", "name", "hcpcs_code",
   "payer_replacement_category")
SELECT m."id", c."component_type", c."name", c."hcpcs_code", c."category"
FROM (VALUES
  ('inogen-aurora-f1', 'cushion', 'Aurora F1 cushion', 'A7031', 'cushion'),
  ('inogen-aurora-f1', 'frame', 'Aurora F1 frame', 'A7030', 'full mask'),
  ('inogen-aurora-f1', 'headgear', 'Aurora F1 headgear', 'A7035', 'headgear'),
  ('inogen-aurora-n1', 'cushion', 'Aurora N1 cushion', 'A7032', 'cushion'),
  ('inogen-aurora-n1', 'frame', 'Aurora N1 frame', 'A7034', 'full mask'),
  ('inogen-aurora-n1', 'headgear', 'Aurora N1 headgear', 'A7035', 'headgear'),
  ('inogen-aurora-p1', 'pillow', 'Aurora P1 nasal pillows', 'A7033', 'pillow'),
  ('inogen-aurora-p1', 'frame', 'Aurora P1 frame', 'A7034', 'full mask'),
  ('inogen-aurora-p1', 'headgear', 'Aurora P1 headgear', 'A7035', 'headgear'),
  ('rain8-ameriflex-yf-01', 'cushion', 'AmeriFlex YF-01 cushion', 'A7031', 'cushion'),
  ('rain8-ameriflex-yf-01', 'frame', 'AmeriFlex YF-01 frame', 'A7030', 'full mask'),
  ('rain8-ameriflex-yf-01', 'headgear', 'AmeriFlex YF-01 headgear', 'A7035', 'headgear'),
  ('rain8-ameriflex-yf-02', 'cushion', 'AmeriFlex YF-02 cushion', 'A7031', 'cushion'),
  ('rain8-ameriflex-yf-02', 'frame', 'AmeriFlex YF-02 frame', 'A7030', 'full mask'),
  ('rain8-ameriflex-yf-02', 'headgear', 'AmeriFlex YF-02 headgear', 'A7035', 'headgear'),
  ('rain8-ameriflex-yn-02', 'cushion', 'AmeriFlex YN-02 cushion', 'A7032', 'cushion'),
  ('rain8-ameriflex-yn-02', 'frame', 'AmeriFlex YN-02 frame', 'A7034', 'full mask'),
  ('rain8-ameriflex-yn-02', 'headgear', 'AmeriFlex YN-02 headgear', 'A7035', 'headgear'),
  ('rain8-ameriflex-yn-03', 'cushion', 'AmeriFlex YN-03 cushion', 'A7032', 'cushion'),
  ('rain8-ameriflex-yn-03', 'frame', 'AmeriFlex YN-03 frame', 'A7034', 'full mask'),
  ('rain8-ameriflex-yn-03', 'headgear', 'AmeriFlex YN-03 headgear', 'A7035', 'headgear'),
  ('rain8-ameriflex-yp-01', 'pillow', 'AmeriFlex YP-01 nasal pillows', 'A7033', 'pillow'),
  ('rain8-ameriflex-yp-01', 'frame', 'AmeriFlex YP-01 frame', 'A7034', 'full mask'),
  ('rain8-ameriflex-yp-01', 'headgear', 'AmeriFlex YP-01 headgear', 'A7035', 'headgear'),
  ('resmed-airfit-x30i', 'pillow', 'AirFit X30i nasal pillows', 'A7029', 'pillow'),
  ('resmed-airfit-x30i', 'cushion', 'AirFit X30i oral cushion', 'A7028', 'cushion'),
  ('resmed-airfit-x30i', 'frame', 'AirFit X30i frame', 'A7027', 'full mask'),
  ('resmed-airfit-x30i', 'headgear', 'AirFit X30i headgear', 'A7035', 'headgear')
) AS c("slug", "component_type", "name", "hcpcs_code", "category")
JOIN "resupply"."mask_models" m
  ON m."slug" = c."slug" AND m."org_id" IS NULL
-- mask_components has no unique key beyond its id, so ON CONFLICT can
-- never fire for it (0486 has the same inert clause). The ledger applies
-- this file once, but guard anyway so a manual re-run cannot duplicate.
WHERE NOT EXISTS (
  SELECT 1 FROM "resupply"."mask_components" x
  WHERE x."mask_model_id" = m."id"
    AND x."component_type" = c."component_type"
    AND x."name" = c."name"
);
