-- 0493_non_magnetic_mask_skus — the same mask, without the magnets.
--
-- Why
-- ---
-- 0481 gave `mask_models` a `magnet_free_variant_slug` column and
-- described its purpose exactly: "Lets the engine offer a same-model
-- non-magnetic swap instead of pushing the patient to a different mask
-- entirely." Nothing ever populated it, and no magnet-free SKU was ever
-- seeded, so the mechanism has been inert since the day it was written.
--
-- The consequence shows up the moment `fitter.magnet_screening` is on.
-- `magnet_implant_patient` is a tier-1 hard filter, so a patient with a
-- pacemaker loses the AirFit F20 outright and is pushed onto a
-- structurally different mask — a different cushion, a different size
-- run, a different thing to learn — when ResMed sells that same mask in
-- a magnet-free version.
--
-- Critically, this is NOT a "swap the clips" note. ResMed's non-magnetic
-- headgear clips only fit the non-magnetic FRAME; they do not convert a
-- magnetic mask. The magnet-free mask is its own SKU, sold separately.
-- Telling a patient otherwise would be a clinical error, which is why
-- this is modelled as a distinct mask rather than an accessory.
--
-- Why a separate `mask_models` row rather than a size variant
-- -----------------------------------------------------------
--   1. `magnet_free_variant_slug` holds a SLUG. `mask_size_variants` has
--      no slug column, so the column this migration exists to light up
--      can only point at another `mask_models` row.
--   2. `has_magnetic_components` is model-level and the tier-1 filter
--      keys off it, as does `safety_screen_questions.disqualifies_
--      attribute`, which literally stores that column's name.
--   3. `fit_sessions.ordered_mask_model_id` is an FK to `mask_models`.
--      If the twin were a variant, a pacemaker patient's permanent
--      record would say they were dispensed the MAGNETIC mask.
--   4. `mask_fit_outcomes.mask_id` feeds computeFitAdjustments(). The two
--      SKUs have different headgear and therefore different strap-leak
--      and comfort profiles; pooling them would contaminate the tuning
--      multiplier for both.
--   5. Precedent: `resmed-airfit-f20-for-her` is already its own model
--      row sharing the F20 cushion platform.
--
-- Scope
-- -----
-- Only the two SKUs with direct evidence: the AirFit F20 (ResMed
-- publishes a dedicated "AirFit F20 non magnetic" support page) and the
-- AirFit F30i. Both are listed as separate formulary entries by
-- SleepGlad, whose catalog prompted this review.
--
-- Deliberately NOT seeded on inference: AirTouch F20, AirFit F30,
-- AirFit N20, AirTouch N20 and AirFit F20 for Her are all magnetic in
-- our catalog, and retailer listings for the non-magnetic CLIPS mention
-- "AirFit/AirTouch F20, F30, F30i" — but a clip listing is not proof
-- that ResMed ships a non-magnetic MASK SYSTEM for each. Seeding a SKU
-- that does not exist into a clinical catalog is worse than the gap.
-- Add them individually once confirmed against ResMed's own catalog.
--
-- What the twins inherit
-- ----------------------
-- Geometry, tolerances and size variants are copied from the parent by
-- INSERT..SELECT rather than retyped, so parity is structural instead of
-- a copy-paste that drifts. That means they also inherit the parent's
-- ESTIMATED bands: every twin variant lands `needs_clinical_review =
-- true` and is capped below high confidence by confidence.ts, exactly
-- like its parent. They add rows to each tenant's sign-off queue.
--
-- Contraindications are copied EXCEPT the two magnet factors. That
-- omission is the entire point of the SKU, and doing it in a WHERE
-- clause makes it self-documenting.
--
-- Known consequence — formulary
-- -----------------------------
-- A formulary rule targeting `resmed-airfit-f20` does NOT cover
-- `resmed-airfit-f20-non-magnetic`. Under a CLOSED formulary the twin
-- falls to the default posture and runTiers marks it `outsideFormulary`,
-- sorting it behind every allowed mask — i.e. the safe SKU is demoted
-- for the very patient who needs it. Auto-inheriting the parent's
-- decision was considered and rejected: it would inherit `allow` past an
-- explicit `deny` too, and 0482's specificity ordering must stay
-- mechanically predictable. A closed-formulary tenant adds the twins to
-- its allow list; see docs/runbooks/activate-clinical-fitter.md.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- 1. The twin model rows.
-- ---------------------------------------------------------------
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
SELECT
  NULL,
  t."twin_slug",
  p."manufacturer",
  t."twin_name",
  p."product_line",
  p."interface_type", p."service_line", p."therapy_modes", p."vented",
  false,
  t."magnet_notes",
  p."pressure_min_cm_h2o", p."pressure_max_cm_h2o", p."minimal_contact",
  p."avoids_nasal_bridge",
  p."hose_position", p."facial_hair_tolerance", p."side_sleeping_tolerance",
  p."claustrophobia_tolerance", p."glasses_compatible", p."cushion_material",
  'Soft fabric with mechanical (non-magnetic) clips',
  p."weight_grams",
  t."twin_description",
  p."status",
  p."successor_slug",
  -- The bands are the parent's estimates. Saying anything else here
  -- would launder an estimate into manufacturer data.
  'estimated', true
FROM (VALUES
  ('resmed-airfit-f20',
   'resmed-airfit-f20-non-magnetic',
   'AirFit F20 Non-Magnetic',
   'Manufacturer''s magnet-free version of the AirFit F20: identical cushion and frame, headgear with mechanical clips instead of magnets. Sold as its own SKU — the non-magnetic clips do NOT fit the magnetic mask.',
   'ResMed''s flagship full face mask with the InfinitySeal silicone cushion, in the magnet-free version. Identical fit and sizing to the standard AirFit F20; the headgear uses mechanical clips, so it is safe alongside pacemakers, defibrillators and other implanted devices.'),
  ('resmed-airfit-f30i',
   'resmed-airfit-f30i-non-magnetic',
   'AirFit F30i Non-Magnetic',
   'Manufacturer''s magnet-free version of the AirFit F30i: identical cushion and frame, headgear with mechanical clips instead of magnets. Sold as its own SKU — the non-magnetic clips do NOT fit the magnetic mask.',
   'Hybrid full-face mask with a top-of-head tube connection, in the magnet-free version. Identical fit and sizing to the standard AirFit F30i; the headgear uses mechanical clips, so it is safe alongside pacemakers, defibrillators and other implanted devices.')
) AS t("parent_slug", "twin_slug", "twin_name", "magnet_notes", "twin_description")
JOIN "resupply"."mask_models" p
  ON p."slug" = t."parent_slug" AND p."org_id" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. Size variants — copied from the parent so parity is structural.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_size_variants"
  ("mask_model_id", "component", "size_code", "size_label", "sort_order",
   "nose_width_min_mm", "nose_width_max_mm",
   "nose_height_min_mm", "nose_height_max_mm",
   "nose_to_chin_min_mm", "nose_to_chin_max_mm",
   "mouth_width_min_mm", "mouth_width_max_mm",
   "face_width_min_mm", "face_width_max_mm",
   "nostril_width_min_mm", "nostril_width_max_mm",
   "is_default", "hcpcs_code", "manufacturer_part_number",
   "status", "fit_data_source", "needs_clinical_review")
SELECT
  twin."id", v."component", v."size_code", v."size_label", v."sort_order",
  v."nose_width_min_mm", v."nose_width_max_mm",
  v."nose_height_min_mm", v."nose_height_max_mm",
  v."nose_to_chin_min_mm", v."nose_to_chin_max_mm",
  v."mouth_width_min_mm", v."mouth_width_max_mm",
  v."face_width_min_mm", v."face_width_max_mm",
  v."nostril_width_min_mm", v."nostril_width_max_mm",
  v."is_default", v."hcpcs_code", v."manufacturer_part_number",
  v."status", v."fit_data_source", v."needs_clinical_review"
FROM (VALUES
  ('resmed-airfit-f20',  'resmed-airfit-f20-non-magnetic'),
  ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic')
) AS t("parent_slug", "twin_slug")
JOIN "resupply"."mask_models" p
  ON p."slug" = t."parent_slug" AND p."org_id" IS NULL
JOIN "resupply"."mask_models" twin
  ON twin."slug" = t."twin_slug" AND twin."org_id" IS NULL
JOIN "resupply"."mask_size_variants" v ON v."mask_model_id" = p."id"
ON CONFLICT ("mask_model_id", "component", "size_code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. Contraindications — everything the parent carries EXCEPT the two
--    magnet factors. The omission is the reason this SKU exists.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_contraindications"
  ("mask_model_id", "factor", "severity", "rationale", "source", "version_date")
SELECT twin."id", c."factor", c."severity", c."rationale", c."source", c."version_date"
FROM (VALUES
  ('resmed-airfit-f20',  'resmed-airfit-f20-non-magnetic'),
  ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic')
) AS t("parent_slug", "twin_slug")
JOIN "resupply"."mask_models" p
  ON p."slug" = t."parent_slug" AND p."org_id" IS NULL
JOIN "resupply"."mask_models" twin
  ON twin."slug" = t."twin_slug" AND twin."org_id" IS NULL
JOIN "resupply"."mask_contraindications" c ON c."mask_model_id" = p."id"
WHERE c."factor" NOT IN ('magnet_implant_patient', 'magnet_implant_household')
ON CONFLICT ("mask_model_id", "factor") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 4. Point each magnetic parent at its twin.
--
-- The IS DISTINCT FROM guard keeps this idempotent: 0486 and everything
-- after it run in railway.json's preDeployCommand on every release, and
-- catalog_version is stamped into every fit report as provenance. A
-- version that climbs on each deploy makes that provenance meaningless.
-- ---------------------------------------------------------------
UPDATE "resupply"."mask_models" m
SET "magnet_free_variant_slug" = t."twin_slug",
    "catalog_version" = m."catalog_version" + 1,
    "updated_at" = now()
FROM (VALUES
  ('resmed-airfit-f20',  'resmed-airfit-f20-non-magnetic'),
  ('resmed-airfit-f30i', 'resmed-airfit-f30i-non-magnetic')
) AS t("parent_slug", "twin_slug")
WHERE m."slug" = t."parent_slug"
  AND m."org_id" IS NULL
  AND m."magnet_free_variant_slug" IS DISTINCT FROM t."twin_slug";
