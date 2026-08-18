-- 0492_magnet_flag_corrections — fix the Tier-1 magnet safety filter.
--
-- Why
-- ---
-- `mask_contraindications.factor = 'magnet_implant_patient'` is seeded
-- `severity = 'exclude'`, which makes it a TIER-1 HARD FILTER in
-- lib/fitting/tiers.ts — nothing downstream can re-admit an excluded
-- mask. That filter is only as good as the data behind it, and the 0486
-- seed got the data wrong in both directions.
--
-- Of the 72 seeded models, only 9 carried `has_magnetic_components =
-- true`. Cross-checking that against the manufacturers' own recall and
-- field-safety notices found eight magnetic masks flagged NON-magnetic
-- and one magnet-free mask flagged magnetic:
--
--   FALSE NEGATIVES (magnetic, but the filter would not exclude them)
--     resmed-airfit-f30          FDA Class I recall list
--     resmed-airfit-n10          FDA Class I recall list
--     resmed-airfit-f40          ResMed IFU: magnets in the frame and
--                                lower headgear clips, up to 400 mT
--     philips-amara-view         Philips field safety notice
--     philips-dreamwear-ff       Philips field safety notice
--     philips-dreamwear-ff-gel   same frame/headgear as DreamWear FF
--     philips-wisp               Philips field safety notice
--     philips-wisp-pediatric     Philips notice names "Wisp Youth"
--
--   FALSE POSITIVE (magnet-free, but the filter would exclude it)
--     fisher-paykel-evora-full   Fisher & Paykel state publicly that
--                                their ENTIRE mask range is magnet-free
--
-- The false negatives are the serious half. With `fitter.magnet_screening`
-- on, a patient — or a household member — with a pacemaker, ICD,
-- neurostimulator, CSF shunt or aneurysm clip was correctly kept off the
-- F20/F30i/N20 family and could then be handed an AirFit F30, an AirFit
-- N10 or a Wisp: masks their own manufacturers recalled for exactly this
-- hazard.
--
-- The false positive is wrong in the opposite direction and worth fixing
-- for the same reason. Fisher & Paykel's magnet-free range is precisely
-- what an implant patient should be steered TOWARD; excluding the Evora
-- Full removed a safe option from the people who need it most.
--
-- Deliberately NOT changed
-- ------------------------
--   react-health-numa-full-face is seeded magnetic and stays that way.
--   React Health publish no magnet statement either way that could be
--   found, and on a safety filter an unverified exclusion is the side to
--   err on. Recorded here so the next person knows it was considered
--   rather than missed.
--
--   The other 62 models were audited in the same pass and are correct:
--   ResMed's non-magnetic range (F10, N30, N30i, P10, P30i, Mirage FX,
--   Pixi, Quattro, Swift), Philips' DreamWear Nasal / Nasal Pillow (the
--   notice names the FULL FACE variant only), and the whole of Fisher &
--   Paykel, Circadiance, Bleep, Sleepnet and Hans Rudolph.
--
-- Sources
-- -------
--   ResMed — FDA Class I recall, "ResMed Ltd. Recalls CPAP Masks with
--   Magnets due to Possible Magnetic Interference with Certain Medical
--   Devices". Affected: AirFit N10, AirFit F20, AirTouch F20, AirFit N20,
--   AirTouch N20, AirFit F30, AirFit F30i (plus "for Her" and F20 NV
--   variants), distributed Jan 2020 – 20 Nov 2023. The AirFit F40 post-
--   dates the recall; its magnets are documented in ResMed's current
--   user guide instead, so no notice date is stamped for it.
--
--   Philips Respironics — field safety notice of 6 Sep 2022, "updated
--   instructions and labeling of specific sleep therapy masks that
--   contain magnetic headgear clips". Named: Amara View, DreamWear Full
--   Face, DreamWisp, Wisp, Wisp Youth, Therapy Mask 3100 NC/SP.
--
--   Fisher & Paykel Healthcare — "Fisher & Paykel Healthcare masks do
--   not contain magnets".
--
-- Scope
-- -----
-- Every statement is scoped to `org_id IS NULL` — the platform catalog.
-- A tenant that added its own private model under one of these slugs
-- owns that row and is not touched.
--
-- `catalog_version` is bumped on every model this migration changes.
-- fit_sessions stamp `catalog_snapshot_version` at compute time, so a
-- report reprinted later has to be able to show that it ran against the
-- pre-correction catalog.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- 1. False negatives — flag the magnetic masks.
-- ---------------------------------------------------------------
UPDATE "resupply"."mask_models" AS m
SET "has_magnetic_components" = true,
    "magnetic_component_notes" = v."notes",
    "catalog_version" = m."catalog_version" + 1,
    "updated_at" = now()
FROM (VALUES
  ('resmed-airfit-f30',
   'Magnetic headgear clips. On the FDA Class I recall list for magnetic interference. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('resmed-airfit-n10',
   'Magnetic headgear clips. On the FDA Class I recall list for magnetic interference. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('resmed-airfit-f40',
   'Magnets in the frame and lower headgear clips, up to 400 mT per ResMed''s user guide. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('philips-amara-view',
   'Magnetic headgear clips. Named in Philips'' 6 Sep 2022 field safety notice. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('philips-dreamwear-ff',
   'Magnetic headgear clips. Named in Philips'' 6 Sep 2022 field safety notice. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('philips-dreamwear-ff-gel',
   'Magnetic headgear clips — same frame and headgear as the DreamWear Full Face named in Philips'' 6 Sep 2022 field safety notice. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('philips-wisp',
   'Magnetic headgear clips. Named in Philips'' 6 Sep 2022 field safety notice. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.'),
  ('philips-wisp-pediatric',
   'Magnetic headgear clips. Named as "Wisp Youth" in Philips'' 6 Sep 2022 field safety notice. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.')
) AS v("slug", "notes")
WHERE m."slug" = v."slug"
  AND m."org_id" IS NULL
  AND m."has_magnetic_components" = false;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. False negatives — add the contraindication rows the filter reads.
--
-- `source = 'manufacturer_ifu'`, not 'clinical_policy': these come from
-- the manufacturers' own recall and safety notices, which is a stronger
-- claim than our own clinical judgement and should be citable as such.
-- Rationale text is patient-facing — it is printed on the fit report —
-- so it stays plain-language and matches the wording already seeded for
-- the F20/N20/F30i family.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_contraindications"
  ("mask_model_id", "factor", "severity", "rationale", "source", "version_date")
SELECT
  m."id",
  f."factor",
  'exclude',
  CASE f."factor"
    WHEN 'magnet_implant_patient' THEN
      'The headgear clips contain magnets, which can interfere with implanted medical devices such as pacemakers, defibrillators, aneurysm clips, cochlear implants, and adjustable shunt valves.'
    ELSE
      'The headgear magnets pose the same interference risk to a household member with an implanted device who handles the mask or sleeps beside the wearer.'
  END,
  'manufacturer_ifu',
  s."version_date"
FROM (VALUES
  ('resmed-airfit-f30',        DATE '2023-11-20'),
  ('resmed-airfit-n10',        DATE '2023-11-20'),
  ('resmed-airfit-f40',        NULL::date),
  ('philips-amara-view',       DATE '2022-09-06'),
  ('philips-dreamwear-ff',     DATE '2022-09-06'),
  ('philips-dreamwear-ff-gel', DATE '2022-09-06'),
  ('philips-wisp',             DATE '2022-09-06'),
  ('philips-wisp-pediatric',   DATE '2022-09-06')
) AS s("slug", "version_date")
CROSS JOIN (VALUES
  ('magnet_implant_patient'),
  ('magnet_implant_household')
) AS f("factor")
JOIN "resupply"."mask_models" m
  ON m."slug" = s."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "factor") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. False positive — the Evora Full is magnet-free.
-- ---------------------------------------------------------------
UPDATE "resupply"."mask_models"
SET "has_magnetic_components" = false,
    "magnetic_component_notes" = NULL,
    "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "slug" = 'fisher-paykel-evora-full'
  AND "org_id" IS NULL
  AND "has_magnetic_components" = true;
--> statement-breakpoint

DELETE FROM "resupply"."mask_contraindications" c
USING "resupply"."mask_models" m
WHERE c."mask_model_id" = m."id"
  AND m."slug" = 'fisher-paykel-evora-full'
  AND m."org_id" IS NULL
  AND c."factor" IN ('magnet_implant_patient', 'magnet_implant_household');
