-- 0522_mask_catalog_manufacturer_audit_corrections — the third wave of
-- catalog corrections, from an external audit re-verified against the
-- manufacturers' own published data.
--
-- Provenance
-- ----------
-- An external LLM audit of the four core manufacturers (ResMed, Fisher &
-- Paykel, Philips Respironics, React Health) was supplied for review. Its
-- findings were NOT taken on trust: every claim was re-checked against a
-- manufacturer-hosted page, and only the ones that cleared this repo's
-- standing evidence bar (docs/mask-size-run-registry-2026-08-21.md — a
-- manufacturer-hosted document/page, or two independent consistent sources,
-- preferably with per-size SKUs) are applied here. Several of its findings
-- were WRONG and are deliberately not applied; several corrections it
-- missed are applied. The per-claim verdicts, the evidence, and the
-- open items live in
-- docs/mask-catalog-manufacturer-audit-2026-08-25.md.
--
-- What was wrong, per model
-- -------------------------
--   ResMed 30i frames    The 30i platform's frame ladder is Small /
--                        Standard (/ Large), never Small/Medium/Large.
--                        The seed used M and L codes on all three of
--                        f30i, n30i and p30i. ResMed's own eshop sells
--                        ONE frame product across F30i and X30i —
--                        "AirFit F30i/X30i Frame" in Small (63368),
--                        Standard (63369) and Large (63370) — while the
--                        N30i and P30i frame systems ship in Small and
--                        Standard ONLY (N30i 63802-63809, P30i
--                        63852-63857, each SKU pairing one frame size
--                        with one cushion). ResMed's own knowledge base
--                        says it in words for the P30i: "AirFit P30i fits
--                        most facial profiles with just two frame size
--                        starter packs, small and standard."
--                        So: rename M -> Standard everywhere, and retire
--                        the Large frame on N30i and P30i (which ResMed
--                        does not sell) while KEEPING it on F30i/X30i
--                        (which ResMed does). The external audit called
--                        for dropping Large from the whole platform;
--                        that half of its finding is wrong.
--   philips-dreamwear-np The row is Philips' GEL pillows cushion — that
--                        is how 0512 corrected its size run ("Three
--                        cushion sizes (small, medium, large)", Philips'
--                        DreamWear brochure) and how the size-run
--                        registry labels it. But the row itself still
--                        said model_name 'DreamWear Nasal Pillow' and
--                        cushion_material 'Silicone', which duplicates
--                        the separate philips-dreamwear-silicone-pillows
--                        model and loses the gel option entirely.
--                        Philips names the product "DreamWear Gel
--                        Pillows" on its own DreamWear page.
--   philips-dreamwisp    Seeded avoids_nasal_bridge = true and described
--                        as an "under-nose nasal cushion". Philips' own
--                        magnet notice names the product "DreamWisp Nasal
--                        Mask with Over the Nose Cushion" and lists
--                        "DreamWear under-the-nose nasal mask" separately
--                        as an ALTERNATIVE to it. It is an over-the-nose
--                        mask; it does not free the nasal bridge, and a
--                        patient steered to it for bridge relief gets the
--                        opposite of what the fitter promised.
--   fisher-paykel-       Seeded frames S/M/L. F&P ship ONE frame ("Evora
--   evora-full           Full Frame Spare", no size) and TWO headgear
--                        sizes, Standard and Extra Large ("There are two
--                        sizes of headgear available"). The seal run
--                        XS / S-M / L that 0512 verified is unchanged.
--   fisher-paykel-solo   Renamed 'Solo' -> 'Solo Nasal'. F&P sell the
--                        Solo platform as two distinct cushions on one
--                        AutoFit headgear — Solo Nasal (S/M/L/W) and Solo
--                        Pillows (S/M/L) — and this row only ever modelled
--                        the nasal cushion. Its own seeded description
--                        already said so.
--   react-health-rio-ii  Renamed 'Rio II' -> 'Rio II Nasal Pillows Mask'.
--                        React sell three distinct Rio II masks; this row
--                        is the pillows one (pillow variants, S/M/L), and
--                        the bare name collided with the Rio II Full Face
--                        and Rio II Nasal added below.
--
-- What was missing
-- ----------------
-- Nine current masks, every one verified on the manufacturer's own site:
--   ResMed        AirTouch F30i Comfort, AirTouch F30i Clear, AirTouch
--                 N30i — all three on ResMed's US professional mask
--                 portfolio page, with per-size SKUs on ResMed's eshop
--                 (AirTouch F30i cushion 62489/62490/62491; Comfort
--                 systems 62442-62446, Clear systems 62404-62408;
--                 AirTouch N30i cushion 62330/62331/62332, systems
--                 62310-62315).
--   F&P           Nova Nasal ("three cushion sizes available: small,
--                 medium, large" + "Two headgear sizes"), Solo Pillows
--                 (its own fit pack and per-size product codes).
--   React Health  Siesta 2 Full Face, Rio II Full Face, Siesta 2 Nasal,
--                 Rio II Nasal — React's PAP mask page lists exactly five
--                 current masks with per-size replacement-cushion part
--                 numbers; PennFit carried only one of them. The external
--                 audit asked for six, including a first-generation
--                 "Siesta Full Face"/"Siesta Nasal"; React list no such
--                 products today, so they are not added.
--
-- Magnets
-- -------
-- The four new React masks land has_magnetic_components = false on
-- React's own words, printed twice on their mask page: "Features easy
-- release clips - not magnets - that are common to all React Health
-- masks." The two new F&P masks land false on F&P's standing statement
-- that their entire range is magnet-free (the same source 0492 used).
--
-- The three new ResMed masks land TRUE, which for the AirTouch N30i is
-- deliberately conservative: ResMed publish no magnet statement for it
-- that could be found, its AirFit N30i platform-mate is non-magnetic
-- (0492), and per 0492's rule an unverified exclusion is the side a
-- safety filter errs on. Recorded in magnetic_component_notes so the
-- clinical sign-off resolves it rather than inheriting it.
--
-- react-health-numa-full-face is NOT flipped to non-magnetic, though the
-- audit asked for it. React's "all React Health masks" statement sits on
-- a page that lists five current masks, and the Numa is not one of them;
-- the statement's scope over a product React no longer list is exactly
-- the ambiguity 0492 refused to resolve by guessing. Flipping it would
-- ADMIT a possibly-magnetic mask to implant patients, which is the
-- expensive direction to be wrong in. The quote is attached to the row's
-- notes for the reviewer instead.
--
-- Mechanics — same rules as 0511/0512
-- -----------------------------------
-- Renames happen IN PLACE so row UUIDs survive for formulary entries,
-- past fit sessions and referrals. Sizes the manufacturer does not ship
-- are retired, never deleted (fit_sessions holds plain foreign keys).
-- New bands use 0511's derivation unchanged — canonical-face anchor,
-- +/-18% envelope, 10% overlap, plausibility-window outer edges — and the
-- band block at the end restates them in the shape catalog-bands.test.ts
-- parses, so the new runs are held to the same tiling proof as every
-- other run. Everything lands fit_data_source='estimated',
-- needs_clinical_review=true: a verified SIZE RUN is not verified
-- GEOMETRY. Sign-offs on touched models are deleted and catalog_version
-- is bumped.
--
-- PHI: none. Product facts only.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- 1. The 30i frame ladder: Medium is called Standard.
-- ---------------------------------------------------------------
-- ResMed's eshop sells the F30i/X30i frame in Small / Standard / Large
-- (63368 / 63369 / 63370) and the N30i and P30i frame systems in Small
-- and Standard. No 30i frame is called "Medium". Renamed in place; the
-- code is what fit reports and order data carry.
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'STD',
    "size_label" = 'Standard',
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN (
    'resmed-airfit-f30i',
    'resmed-airfit-f30i-non-magnetic',
    'resmed-airfit-n30i',
    'resmed-airfit-p30i'
  )
  AND v."component" = 'frame'
  AND v."size_code" = 'M';
--> statement-breakpoint

-- While here: the 0486 seed stored the frame LABEL as the bare code, so
-- the corrected run would read "S / Standard / L". The X30i rows (0494)
-- already spell them out; match them so the ladder reads as one run.
UPDATE "resupply"."mask_size_variants" v
SET "size_label" = CASE v."size_code" WHEN 'S' THEN 'Small' ELSE 'Large' END,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN (
    'resmed-airfit-f30i',
    'resmed-airfit-f30i-non-magnetic',
    'resmed-airfit-n30i',
    'resmed-airfit-p30i'
  )
  AND v."component" = 'frame'
  AND v."size_code" IN ('S', 'L')
  AND v."size_label" = v."size_code";
--> statement-breakpoint

-- The Large frame exists on the F30i/X30i platform and NOT on the N30i
-- or P30i, whose frame systems ResMed sell in two sizes only. Retire —
-- do not delete — the two that were invented.
UPDATE "resupply"."mask_size_variants" v
SET "status" = 'discontinued',
    "sort_order" = 900 + v."sort_order",
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN ('resmed-airfit-n30i', 'resmed-airfit-p30i')
  AND v."component" = 'frame'
  AND v."size_code" = 'L'
  AND v."status" IS DISTINCT FROM 'discontinued';
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 2. philips-dreamwear-np is Philips' GEL pillows cushion.
-- ---------------------------------------------------------------
-- 0512 already corrected this row's size run AS the gel pillows (Philips'
-- DreamWear brochure: "Three cushion sizes (small, medium, large)") and
-- the size-run registry labels it "DreamWear Gel Pillows". The row's own
-- name and material never followed, leaving a duplicate-looking silicone
-- product next to philips-dreamwear-silicone-pillows and no gel option in
-- the catalog at all. Philips name the product "DreamWear Gel Pillows".
UPDATE "resupply"."mask_models"
SET "model_name" = 'DreamWear Gel Pillows',
    "product_line" = 'DreamWear',
    "cushion_material" = 'Gel (gel-ringed nasal pillows)',
    "description" = 'The gel-pillows cushion for the DreamWear frame: soft gel-ringed pillows that seat at the nostrils, on the same top-of-head tube frame the DreamWear nasal and full face cushions use. Philips'' silicone pillows are a separate cushion (DreamWear with Silicone Pillows) on the same frame.',
    "updated_at" = now()
WHERE "slug" = 'philips-dreamwear-np' AND "org_id" IS NULL;
--> statement-breakpoint

UPDATE "resupply"."mask_components"
SET "name" = REPLACE("name", 'DreamWear Nasal Pillow', 'DreamWear Gel Pillows'),
    "updated_at" = now()
WHERE "mask_model_id" IN (
        SELECT "id" FROM "resupply"."mask_models"
        WHERE "slug" = 'philips-dreamwear-np' AND "org_id" IS NULL)
  AND "name" LIKE '%DreamWear Nasal Pillow%';
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 3. DreamWisp sits OVER the nose.
-- ---------------------------------------------------------------
-- Philips' own magnet notice names the product "DreamWisp Nasal Mask with
-- Over the Nose Cushion", and lists "DreamWear under-the-nose nasal mask"
-- separately as one of its alternatives. The seed had it as an under-nose
-- cushion that avoids the nasal bridge, which is the single fact a
-- patient with bridge soreness or a bridge pressure injury is steered by.
UPDATE "resupply"."mask_models"
SET "avoids_nasal_bridge" = false,
    -- The seed also had this mask scored as if a beard broke its seal:
    -- facial_hair_tolerance='poor' plus a facial_hair contraindication
    -- whose rationale reads "the seal runs across the cheeks and chin".
    -- That is a FULL FACE rationale on a mask that seals on the nose. It
    -- is the same misreading this section exists to fix, it left the DB
    -- and static-catalog paths ranking bearded patients differently, and
    -- of the 32 current nasal masks only this one and the AirFit N20
    -- carried it. 'fair' is the value its closest comparable — the
    -- DreamWear nasal cushion, same over-the-nose class, same
    -- top-of-head tube — already carries.
    "facial_hair_tolerance" = 'fair',
    "cushion_material" = 'Silicone (Wisp over-the-nose nasal cushion)',
    "description" = 'Nasal mask pairing the Wisp''s compact over-the-nose cushion with a top-of-head tube connection, so the hose routes over the crown instead of across the chest. The cushion covers the nose and rests against the nasal bridge — it is not an under-nose cradle.',
    "updated_at" = now()
WHERE "slug" = 'philips-dreamwisp' AND "org_id" IS NULL;
--> statement-breakpoint

DELETE FROM "resupply"."mask_contraindications" c
USING "resupply"."mask_models" m
WHERE c."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" = 'philips-dreamwisp'
  AND c."factor" = 'facial_hair';
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 4. Evora Full has one frame and two headgear sizes.
-- ---------------------------------------------------------------
-- F&P's Evora Full page: "There are two sizes of headgear available"
-- (Standard, Extra Large), and the product-code list carries a single
-- "Evora Full Frame Spare" with no size. The seeded S/M/L frames do not
-- exist. The XS / S-M / L SEAL run 0512 verified is untouched.
UPDATE "resupply"."mask_size_variants" v
SET "size_code" = 'ONE',
    "size_label" = 'One size',
    "sort_order" = 0,
    -- The seed's default frame was M, retired below. A run whose only
    -- current row is not the default leaves the catalog with no default
    -- frame at all, so the surviving universal frame takes it.
    "is_default" = true,
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" = 'fisher-paykel-evora-full'
  AND v."component" = 'frame'
  AND v."size_code" = 'S';
--> statement-breakpoint

UPDATE "resupply"."mask_size_variants" v
SET "status" = 'discontinued',
    "sort_order" = 900 + v."sort_order",
    "updated_at" = now()
FROM "resupply"."mask_models" m
WHERE v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" = 'fisher-paykel-evora-full'
  AND v."component" = 'frame'
  AND v."size_code" IN ('M', 'L')
  AND v."status" IS DISTINCT FROM 'discontinued';
--> statement-breakpoint


-- ---------------------------------------------------------------
-- 5. Names that stopped being unique.
-- ---------------------------------------------------------------
-- F&P sell the Solo platform as two cushions on one AutoFit headgear;
-- this row is the nasal one, and Solo Pillows is added below.
UPDATE "resupply"."mask_models"
SET "model_name" = 'Solo Nasal',
    "product_line" = 'Solo',
    "updated_at" = now()
WHERE "slug" = 'fisher-paykel-solo' AND "org_id" IS NULL;
--> statement-breakpoint

-- React sell three Rio II masks. This row is the nasal pillows one.
UPDATE "resupply"."mask_models"
SET "model_name" = 'Rio II Nasal Pillows Mask',
    "updated_at" = now()
WHERE "slug" = 'react-health-rio-ii' AND "org_id" IS NULL;
--> statement-breakpoint

-- Numa keeps has_magnetic_components = true; see the header. The
-- manufacturer statement that argues the other way is recorded so the
-- reviewer resolves it rather than rediscovering it.
UPDATE "resupply"."mask_models"
SET "magnetic_component_notes" =
      'Magnetic headgear clips, per the 0486 seed and unverified since. UNRESOLVED: React Health''s current PAP mask page states "easy release clips - not magnets - that are common to all React Health masks", but lists only their five current masks and the Numa is not among them. Kept excluded pending a manufacturer answer, per the safety-filter rule in 0492. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.',
    "updated_at" = now()
WHERE "slug" = 'react-health-numa-full-face' AND "org_id" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 6. Nine current masks the catalog did not carry.
-- ---------------------------------------------------------------
-- Every model verified on the manufacturer's own site; see the header
-- for the per-model source and SKU evidence. Pressure ranges and weights
-- are NULL rather than guessed — the engine treats NULL as "skip the
-- check", never as a value (same rule as 0494).
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
  (NULL, 'resmed-airtouch-f30i-comfort', 'ResMed', 'AirTouch F30i Comfort', 'AirTouch',
   'hybrid', 'adult', ARRAY['pap']::text[], 'vented',
   true, 'Magnetic headgear clips assumed from the AirFit F30i platform, which the FDA Class I recall names. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.',
   NULL, NULL, true,
   true,
   'top', 'poor', 'good',
   'good', true, 'ComfiSoft fabric',
   'Fabric-wrapped frame with soft headgear', NULL, 'Full face mask on ResMed''s 30i platform with a fully fabric-wrapped frame and a soft ComfiSoft fabric cushion, an under-the-nose UltraCompact fit and a top-of-head tube connection. The cushion is interchangeable with the AirFit F30i and AirFit X30i cushions.', 'current',
   NULL, 'estimated', true),
  (NULL, 'resmed-airtouch-f30i-clear', 'ResMed', 'AirTouch F30i Clear', 'AirTouch',
   'hybrid', 'adult', ARRAY['pap']::text[], 'vented',
   true, 'Magnetic headgear clips assumed from the AirFit F30i platform, which the FDA Class I recall names. Excluded automatically when the safety screen flags an implanted device for the patient or a household member.',
   NULL, NULL, true,
   true,
   'top', 'poor', 'good',
   'good', true, 'ComfiSoft fabric',
   'Clear frame with soft headgear', NULL, 'The AirTouch F30i''s ComfiSoft fabric cushion on ResMed''s clear frame rather than the fabric-wrapped one — same under-the-nose UltraCompact fit, same top-of-head tube, same cushion sizes as the AirTouch F30i Comfort.', 'current',
   NULL, 'estimated', true),
  (NULL, 'resmed-airtouch-n30i', 'ResMed', 'AirTouch N30i', 'AirTouch',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   true, 'UNVERIFIED. ResMed publish no magnet statement for the AirTouch N30i that could be found, and its AirFit N30i platform-mate is magnet-free (0492). Seeded magnetic because an unverified exclusion is the side a safety filter errs on; the clinical sign-off should resolve it against ResMed''''s user guide.',
   NULL, NULL, true,
   true,
   'top', 'fair', 'good',
   'good', true, 'ComfiSoft fabric (nasal cradle)',
   'Fabric-wrapped frame with soft headgear', NULL, 'Tube-up nasal cradle mask with a frame and cushion fully wrapped in soft fabric. Seals under the nose with nothing on the bridge, and routes the hose over the crown of the head. Shares the AirFit N30i and P30i cushion mount.', 'current',
   NULL, 'estimated', true),
  (NULL, 'fisher-paykel-nova-nasal', 'Fisher & Paykel', 'Nova Nasal', 'Nova',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. Fisher & Paykel Healthcare state that their masks do not contain magnets.',
   NULL, NULL, true,
   false,
   'front', 'good', 'good',
   'good', true, 'Silicone (RollFit seal)',
   'SwingFit headgear (standard and large)', NULL, 'Nasal mask whose RollFit cushion sits low on the nose for a clear field of view, with SwingFit headgear that swings around the head and self-aligns to the frame. Stability arms are wrapped in AirEdge fabric to limit face marking, and the tube can be routed over the head.', 'current',
   NULL, 'estimated', true),
  (NULL, 'fisher-paykel-solo-pillows', 'Fisher & Paykel', 'Solo Pillows', 'Solo',
   'nasal_pillow', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. Fisher & Paykel Healthcare state that their masks do not contain magnets.',
   NULL, NULL, true,
   true,
   'front', 'good', 'good',
   'good', true, 'Silicone (AirPillow cushion)',
   'AutoFit/AutoLock stretch headgear (one size, no buckles)', NULL, 'The nasal-pillows cushion of the F&P Solo platform: AirPillow cushions that sit in and around the nose, on the same one-size AutoFit headgear the Solo Nasal cushion uses. The two cushions are interchangeable on one headgear and are sold separately.', 'current',
   NULL, 'estimated', true),
  (NULL, 'react-health-siesta-2-full-face', 'React Health', 'Siesta 2 Full Face', 'Siesta',
   'full_face', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. React Health state on their PAP mask page: "Features easy release clips - not magnets - that are common to all React Health masks."',
   NULL, NULL, false,
   false,
   'front', 'poor', 'good',
   'poor', true, 'Silicone',
   'Crown-style headgear with easy-release clips', NULL, 'React Health''s current full face mask, with a forehead-free frame for a clearer line of vision and a circular dispersion vent on the frame that keeps airflow out of the wearer''s eyes. Crown-style headgear with shorter, lower straps; the headgear is shared with the Siesta 2 Nasal.', 'current',
   NULL, 'estimated', true),
  (NULL, 'react-health-rio-ii-full-face', 'React Health', 'Rio II Full Face', 'Rio',
   'full_face', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. React Health state on their PAP mask page: "Features easy release clips - not magnets - that are common to all React Health masks."',
   NULL, NULL, true,
   true,
   'front', 'poor', 'good',
   'good', true, 'Silicone (under-the-nose cushion)',
   'Adjustable headgear with easy-release clips', NULL, 'React Health''s best-selling full face mask. An under-the-nose cushion frees the nasal bridge, which can reduce feelings of claustrophobia, and a circular dispersion vent keeps it quiet at around 17 dB(A). One modular frame takes all three cushion sizes.', 'current',
   NULL, 'estimated', true),
  (NULL, 'react-health-siesta-2-nasal', 'React Health', 'Siesta 2 Nasal', 'Siesta',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. React Health state on their PAP mask page: "Features easy release clips - not magnets - that are common to all React Health masks."',
   NULL, NULL, true,
   false,
   'front', 'good', 'good',
   'good', true, 'Silicone (SmartFlex adaptive crease)',
   'Crown-style headgear with easy-release clips', NULL, 'Nasal mask on React Health''s Siesta 2 platform. A SmartFlex adaptive crease lets the wearer move without breaking the seal, a lower-profile frame improves line of sight, and padded support arms cushion the cheek contact points. Headgear is shared with the Siesta 2 Full Face.', 'current',
   NULL, 'estimated', true),
  (NULL, 'react-health-rio-ii-nasal', 'React Health', 'Rio II Nasal', 'Rio',
   'nasal', 'adult', ARRAY['pap']::text[], 'vented',
   false, 'Non-magnetic. React Health state on their PAP mask page: "Features easy release clips - not magnets - that are common to all React Health masks."',
   NULL, NULL, true,
   true,
   'front', 'good', 'good',
   'good', true, 'Silicone (under-the-nose cushion)',
   'Adjustable headgear with easy-release clips', NULL, 'Nasal mask with an under-the-nose cushion for pressure relief across the nasal bridge and a 360-degree hose swivel that lets active sleepers move without dislodging the mask. Circular vent dispersion keeps it to around 20 dB.', 'current',
   NULL, 'estimated', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 7a. Evora Full headgear.
-- ---------------------------------------------------------------
-- The two headgear sizes, replacing the frame sizes retired in
-- section 4. Headgear carries no facial geometry.
INSERT INTO "resupply"."mask_size_variants"
  ("mask_model_id", "component", "size_code", "size_label", "sort_order",
   "is_default", "hcpcs_code", "fit_data_source", "needs_clinical_review")
SELECT m."id", v."component", v."size_code", v."size_label", v."sort_order",
       v."is_default", v."hcpcs_code", 'estimated', true
FROM (VALUES
  ('fisher-paykel-evora-full', 'headgear', 'STD', 'Standard',    0, true,  'A7035'),
  ('fisher-paykel-evora-full', 'headgear', 'XL',  'Extra Large', 10, false, 'A7035')
) AS v("slug", "component", "size_code", "size_label", "sort_order",
       "is_default", "hcpcs_code")
JOIN "resupply"."mask_models" m
  ON m."slug" = v."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "component", "size_code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 7b. The new masks' size runs.
-- ---------------------------------------------------------------
-- Size codes are as the manufacturer prints them, and where the
-- manufacturer publishes a per-size part number it is recorded. Bands
-- use 0511's derivation for the run length and interface class — the
-- SIZE RUN is manufacturer-verified, the GEOMETRY is not, so every row
-- lands fit_data_source='estimated' and needs_clinical_review=true.
INSERT INTO "resupply"."mask_size_variants"
  ("mask_model_id", "component", "size_code", "size_label", "sort_order",
   "nose_width_min_mm", "nose_width_max_mm",
   "nose_height_min_mm", "nose_height_max_mm",
   "nose_to_chin_min_mm", "nose_to_chin_max_mm",
   "mouth_width_min_mm", "mouth_width_max_mm",
   "is_default", "hcpcs_code", "manufacturer_part_number",
   "fit_data_source", "needs_clinical_review")
SELECT m."id", v."component", v."size_code", v."size_label", v."sort_order",
       v."nw_min", v."nw_max", v."nh_min", v."nh_max",
       v."nc_min", v."nc_max", v."mw_min", v."mw_max",
       v."is_default", v."hcpcs_code", v."part_number", 'estimated', true
FROM (VALUES
  -- resmed-airtouch-f30i-comfort
  ('resmed-airtouch-f30i-comfort', 'cushion', 'SW', 'Small Wide', 0,
   20, 34, NULL, NULL, 55, 85.1, 30, 46.8,
   false, 'A7031', '62489'),
  ('resmed-airtouch-f30i-comfort', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7,
   true, 'A7031', '62490'),
  ('resmed-airtouch-f30i-comfort', 'cushion', 'L', 'Large', 20,
   37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70,
   false, 'A7031', '62491'),
  -- resmed-airtouch-f30i-clear
  ('resmed-airtouch-f30i-clear', 'cushion', 'SW', 'Small Wide', 0,
   20, 34, NULL, NULL, 55, 85.1, 30, 46.8,
   false, 'A7031', '62489'),
  ('resmed-airtouch-f30i-clear', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7,
   true, 'A7031', '62490'),
  ('resmed-airtouch-f30i-clear', 'cushion', 'L', 'Large', 20,
   37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70,
   false, 'A7031', '62491'),
  -- resmed-airtouch-n30i
  ('resmed-airtouch-n30i', 'cushion', 'SW', 'Small-Wide', 0,
   20, 34, 18, 28, NULL, NULL, NULL, NULL,
   false, 'A7032', '62330'),
  ('resmed-airtouch-n30i', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL,
   true, 'A7032', '62331'),
  ('resmed-airtouch-n30i', 'cushion', 'L', 'Large', 20,
   37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL,
   false, 'A7032', '62332'),
  -- fisher-paykel-nova-nasal
  ('fisher-paykel-nova-nasal', 'cushion', 'S', 'Small', 0,
   20, 34, 18, 28, NULL, NULL, NULL, NULL,
   false, 'A7032', NULL),
  ('fisher-paykel-nova-nasal', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL,
   true, 'A7032', NULL),
  ('fisher-paykel-nova-nasal', 'cushion', 'L', 'Large', 20,
   37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL,
   false, 'A7032', NULL),
  -- fisher-paykel-solo-pillows
  ('fisher-paykel-solo-pillows', 'pillow', 'S', 'Small', 0,
   20, 34, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7033', NULL),
  ('fisher-paykel-solo-pillows', 'pillow', 'M', 'Medium', 10,
   33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7033', NULL),
  ('fisher-paykel-solo-pillows', 'pillow', 'L', 'Large', 20,
   37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7033', NULL),
  -- react-health-siesta-2-full-face
  ('react-health-siesta-2-full-face', 'cushion', 'S', 'Small', 0,
   20, 34, NULL, NULL, 55, 85.1, 30, 46.8,
   false, 'A7031', 'SFF23001'),
  ('react-health-siesta-2-full-face', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7,
   true, 'A7031', 'SFF23002'),
  ('react-health-siesta-2-full-face', 'cushion', 'L', 'Large', 20,
   37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70,
   false, 'A7031', 'SFF23003'),
  -- react-health-rio-ii-full-face
  ('react-health-rio-ii-full-face', 'cushion', 'S', 'Small', 0,
   20, 34, NULL, NULL, 55, 85.1, 30, 46.8,
   false, 'A7031', 'RFF3001'),
  ('react-health-rio-ii-full-face', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7,
   true, 'A7031', 'RFF3002'),
  ('react-health-rio-ii-full-face', 'cushion', 'L', 'Large', 20,
   37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70,
   false, 'A7031', 'RFF3003'),
  -- react-health-siesta-2-nasal
  ('react-health-siesta-2-nasal', 'cushion', 'S', 'Small', 0,
   20, 34, 18, 28, NULL, NULL, NULL, NULL,
   false, 'A7032', 'SNM3001'),
  ('react-health-siesta-2-nasal', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL,
   true, 'A7032', 'SNM3002'),
  ('react-health-siesta-2-nasal', 'cushion', 'L', 'Large', 20,
   37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL,
   false, 'A7032', 'SNM3003'),
  -- react-health-rio-ii-nasal
  ('react-health-rio-ii-nasal', 'cushion', 'S', 'Small', 0,
   20, 34, 18, 28, NULL, NULL, NULL, NULL,
   false, 'A7032', 'RNM3001'),
  ('react-health-rio-ii-nasal', 'cushion', 'M', 'Medium', 10,
   33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL,
   true, 'A7032', 'RNM3002'),
  ('react-health-rio-ii-nasal', 'cushion', 'L', 'Large', 20,
   37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL,
   false, 'A7032', 'RNM3003'),
  -- resmed-airtouch-f30i-comfort (frames carry no facial geometry)
  ('resmed-airtouch-f30i-comfort', 'frame', 'S', 'Small', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7030', NULL),
  ('resmed-airtouch-f30i-comfort', 'frame', 'STD', 'Standard', 10,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7030', NULL),
  ('resmed-airtouch-f30i-comfort', 'frame', 'L', 'Large', 20,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7030', NULL),
  -- resmed-airtouch-f30i-clear (frames carry no facial geometry)
  ('resmed-airtouch-f30i-clear', 'frame', 'S', 'Small', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7030', NULL),
  ('resmed-airtouch-f30i-clear', 'frame', 'STD', 'Standard', 10,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7030', NULL),
  ('resmed-airtouch-f30i-clear', 'frame', 'L', 'Large', 20,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7030', NULL),
  -- resmed-airtouch-n30i (frames carry no facial geometry)
  ('resmed-airtouch-n30i', 'frame', 'S', 'Small', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7034', NULL),
  ('resmed-airtouch-n30i', 'frame', 'STD', 'Standard', 10,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7034', NULL),
  -- fisher-paykel-nova-nasal (headgears carry no facial geometry)
  ('fisher-paykel-nova-nasal', 'headgear', 'STD', 'Standard', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7035', NULL),
  ('fisher-paykel-nova-nasal', 'headgear', 'L', 'Large', 10,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   false, 'A7035', NULL),
  -- fisher-paykel-solo-pillows (headgears carry no facial geometry)
  ('fisher-paykel-solo-pillows', 'headgear', 'ONE', 'One size', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   true, 'A7035', NULL)
) AS v("slug", "component", "size_code", "size_label", "sort_order",
       "nw_min", "nw_max", "nh_min", "nh_max",
       "nc_min", "nc_max", "mw_min", "mw_max",
       "is_default", "hcpcs_code", "part_number")
JOIN "resupply"."mask_models" m
  ON m."slug" = v."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "component", "size_code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 8. Their contraindications.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_contraindications"
  ("mask_model_id", "factor", "severity", "rationale", "source")
SELECT m."id", c."factor", c."severity", c."rationale", c."source"
FROM (VALUES
  -- Full face / hybrid: the standard soft cautions, worded as 0486/0494.
  ('resmed-airtouch-f30i-comfort', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('resmed-airtouch-f30i-comfort', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  ('resmed-airtouch-f30i-clear', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('resmed-airtouch-f30i-clear', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  ('react-health-siesta-2-full-face', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('react-health-siesta-2-full-face', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  ('react-health-rio-ii-full-face', 'claustrophobia', 'caution', 'This mask covers a comparatively large area of the face, which patients who report claustrophobia often struggle to tolerate.', 'clinical_policy'),
  ('react-health-rio-ii-full-face', 'facial_hair', 'caution', 'The seal runs across the cheeks and chin, where beard hair breaks the seal and causes leak. Trimming close, or moving to a nasal pillow interface, usually resolves it.', 'clinical_policy'),
  -- Nasal and pillow interfaces: the standard airway cautions.
  ('resmed-airtouch-n30i', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('resmed-airtouch-n30i', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('fisher-paykel-nova-nasal', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('fisher-paykel-nova-nasal', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('react-health-siesta-2-nasal', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('react-health-siesta-2-nasal', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('react-health-rio-ii-nasal', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('react-health-rio-ii-nasal', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  ('fisher-paykel-solo-pillows', 'mouth_breathing', 'caution', 'Nasal interfaces vent pressure through an open mouth, so a persistent mouth breather may lose therapy pressure. A chinstrap sometimes resolves this; a full face or hybrid mask reliably does.', 'clinical_policy'),
  ('fisher-paykel-solo-pillows', 'nasal_obstruction', 'caution', 'A nasal route depends on a patent airway. Persistent congestion or obstruction reduces effective therapy and drives mouth leak.', 'clinical_policy'),
  -- The three new ResMed masks carry the magnet exclusions on the
  -- conservative platform assumption documented in the header.
  ('resmed-airtouch-f30i-comfort', 'magnet_implant_patient', 'exclude', 'The headgear clips are taken to contain magnets, which can interfere with implanted medical devices such as pacemakers, defibrillators, aneurysm clips, cochlear implants, and adjustable shunt valves. Sourced from the model''s platform rather than its own IFU - see the model''s magnetic_component_notes.', 'clinical_policy'),
  ('resmed-airtouch-f30i-comfort', 'magnet_implant_household', 'exclude', 'The headgear magnets pose the same interference risk to a household member with an implanted device who handles the mask or sleeps beside the wearer.', 'clinical_policy'),
  ('resmed-airtouch-f30i-clear', 'magnet_implant_patient', 'exclude', 'The headgear clips are taken to contain magnets, which can interfere with implanted medical devices such as pacemakers, defibrillators, aneurysm clips, cochlear implants, and adjustable shunt valves. Sourced from the model''s platform rather than its own IFU - see the model''s magnetic_component_notes.', 'clinical_policy'),
  ('resmed-airtouch-f30i-clear', 'magnet_implant_household', 'exclude', 'The headgear magnets pose the same interference risk to a household member with an implanted device who handles the mask or sleeps beside the wearer.', 'clinical_policy'),
  ('resmed-airtouch-n30i', 'magnet_implant_patient', 'exclude', 'The headgear clips are taken to contain magnets, which can interfere with implanted medical devices such as pacemakers, defibrillators, aneurysm clips, cochlear implants, and adjustable shunt valves. Sourced from the model''s platform rather than its own IFU - see the model''s magnetic_component_notes.', 'clinical_policy'),
  ('resmed-airtouch-n30i', 'magnet_implant_household', 'exclude', 'The headgear magnets pose the same interference risk to a household member with an implanted device who handles the mask or sleeps beside the wearer.', 'clinical_policy')
) AS c("slug", "factor", "severity", "rationale", "source")
JOIN "resupply"."mask_models" m
  ON m."slug" = c."slug" AND m."org_id" IS NULL
ON CONFLICT ("mask_model_id", "factor") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 9. Their replaceable components.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."mask_components"
  ("mask_model_id", "component_type", "name", "hcpcs_code",
   "payer_replacement_category")
SELECT m."id", c."component_type", c."name", c."hcpcs_code", c."category"
FROM (VALUES
  ('resmed-airtouch-f30i-comfort', 'cushion', 'AirTouch F30i Comfort cushion', 'A7031', 'cushion'),
  ('resmed-airtouch-f30i-comfort', 'frame', 'AirTouch F30i Comfort frame', 'A7030', 'full mask'),
  ('resmed-airtouch-f30i-comfort', 'headgear', 'AirTouch F30i Comfort headgear', 'A7035', 'headgear'),
  ('resmed-airtouch-f30i-clear', 'cushion', 'AirTouch F30i Clear cushion', 'A7031', 'cushion'),
  ('resmed-airtouch-f30i-clear', 'frame', 'AirTouch F30i Clear frame', 'A7030', 'full mask'),
  ('resmed-airtouch-f30i-clear', 'headgear', 'AirTouch F30i Clear headgear', 'A7035', 'headgear'),
  ('resmed-airtouch-n30i', 'cushion', 'AirTouch N30i cushion', 'A7032', 'cushion'),
  ('resmed-airtouch-n30i', 'frame', 'AirTouch N30i frame', 'A7034', 'full mask'),
  ('resmed-airtouch-n30i', 'headgear', 'AirTouch N30i headgear', 'A7035', 'headgear'),
  ('fisher-paykel-nova-nasal', 'cushion', 'Nova Nasal cushion', 'A7032', 'cushion'),
  ('fisher-paykel-nova-nasal', 'frame', 'Nova Nasal frame', 'A7034', 'full mask'),
  ('fisher-paykel-nova-nasal', 'headgear', 'Nova Nasal headgear', 'A7035', 'headgear'),
  ('fisher-paykel-solo-pillows', 'pillow', 'Solo Pillows nasal pillows', 'A7033', 'pillow'),
  ('fisher-paykel-solo-pillows', 'frame', 'Solo Pillows frame', 'A7034', 'full mask'),
  ('fisher-paykel-solo-pillows', 'headgear', 'Solo Pillows headgear', 'A7035', 'headgear'),
  ('react-health-siesta-2-full-face', 'cushion', 'Siesta 2 Full Face cushion', 'A7031', 'cushion'),
  ('react-health-siesta-2-full-face', 'frame', 'Siesta 2 Full Face frame', 'A7030', 'full mask'),
  ('react-health-siesta-2-full-face', 'headgear', 'Siesta 2 Full Face headgear', 'A7035', 'headgear'),
  ('react-health-rio-ii-full-face', 'cushion', 'Rio II Full Face cushion', 'A7031', 'cushion'),
  ('react-health-rio-ii-full-face', 'frame', 'Rio II Full Face frame', 'A7030', 'full mask'),
  ('react-health-rio-ii-full-face', 'headgear', 'Rio II Full Face headgear', 'A7035', 'headgear'),
  ('react-health-siesta-2-nasal', 'cushion', 'Siesta 2 Nasal cushion', 'A7032', 'cushion'),
  ('react-health-siesta-2-nasal', 'frame', 'Siesta 2 Nasal frame', 'A7034', 'full mask'),
  ('react-health-siesta-2-nasal', 'headgear', 'Siesta 2 Nasal headgear', 'A7035', 'headgear'),
  ('react-health-rio-ii-nasal', 'cushion', 'Rio II Nasal cushion', 'A7032', 'cushion'),
  ('react-health-rio-ii-nasal', 'frame', 'Rio II Nasal frame', 'A7034', 'full mask'),
  ('react-health-rio-ii-nasal', 'headgear', 'Rio II Nasal headgear', 'A7035', 'headgear')
) AS c("slug", "component_type", "name", "hcpcs_code", "category")
JOIN "resupply"."mask_models" m
  ON m."slug" = c."slug" AND m."org_id" IS NULL
-- NOT a redundant ON CONFLICT. `mask_components` carries only a uuid
-- primary key and two NON-unique indexes, so ON CONFLICT DO NOTHING
-- (which 0486 and 0494 both use here) matches no arbiter and suppresses
-- nothing: a replay of this file would insert a second copy of all 27
-- rows and the admin catalog would show every replacement part twice.
WHERE NOT EXISTS (
  SELECT 1
    FROM "resupply"."mask_components" existing
   WHERE existing."mask_model_id"  = m."id"
     AND existing."component_type" = c."component_type"
     AND existing."name"           = c."name"
);
--> statement-breakpoint

-- ---------------------------------------------------------------
-- 10. The new runs, restated on 0511's derivation.
-- ---------------------------------------------------------------
-- Same statement shape 0511/0512 use, and the same reason: this block is
-- what catalog-bands.test.ts parses, so the new runs are held to the
-- window-containment and no-gap tiling proofs alongside every existing
-- run rather than being exempt from them. The values are the standard
-- three-rung ladder for the interface class — canonical-face anchor,
-- +/-18% envelope, 10% overlap, outer edges at the plausibility window.
UPDATE "resupply"."mask_size_variants" v
SET "nose_width_min_mm" = x."nw_min",   "nose_width_max_mm" = x."nw_max",
    "nose_height_min_mm" = x."nh_min",  "nose_height_max_mm" = x."nh_max",
    "nose_to_chin_min_mm" = x."nc_min", "nose_to_chin_max_mm" = x."nc_max",
    "mouth_width_min_mm" = x."mw_min",  "mouth_width_max_mm" = x."mw_max",
    "updated_at" = now()
FROM (VALUES
  -- resmed-airtouch-f30i-comfort (hybrid, adult)
  ('resmed-airtouch-f30i-comfort', 'cushion', 'SW', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airtouch-f30i-comfort', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airtouch-f30i-comfort', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- resmed-airtouch-f30i-clear (hybrid, adult)
  ('resmed-airtouch-f30i-clear', 'cushion', 'SW', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('resmed-airtouch-f30i-clear', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('resmed-airtouch-f30i-clear', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- resmed-airtouch-n30i (nasal, adult)
  ('resmed-airtouch-n30i', 'cushion', 'SW', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('resmed-airtouch-n30i', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('resmed-airtouch-n30i', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- fisher-paykel-nova-nasal (nasal, adult)
  ('fisher-paykel-nova-nasal', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('fisher-paykel-nova-nasal', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('fisher-paykel-nova-nasal', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- fisher-paykel-solo-pillows (nasal_pillow, adult)
  ('fisher-paykel-solo-pillows', 'pillow', 'S', 20, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-solo-pillows', 'pillow', 'M', 33.1, 38.3, NULL, NULL, NULL, NULL, NULL, NULL),
  ('fisher-paykel-solo-pillows', 'pillow', 'L', 37.4, 55, NULL, NULL, NULL, NULL, NULL, NULL),
  -- react-health-siesta-2-full-face (full_face, adult)
  ('react-health-siesta-2-full-face', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('react-health-siesta-2-full-face', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('react-health-siesta-2-full-face', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- react-health-rio-ii-full-face (full_face, adult)
  ('react-health-rio-ii-full-face', 'cushion', 'S', 20, 34, NULL, NULL, 55, 85.1, 30, 46.8),
  ('react-health-rio-ii-full-face', 'cushion', 'M', 33.1, 38.3, NULL, NULL, 83, 95.8, 45.6, 52.7),
  ('react-health-rio-ii-full-face', 'cushion', 'L', 37.4, 55, NULL, NULL, 93.7, 125, 51.5, 70),
  -- react-health-siesta-2-nasal (nasal, adult)
  ('react-health-siesta-2-nasal', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('react-health-siesta-2-nasal', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('react-health-siesta-2-nasal', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL),
  -- react-health-rio-ii-nasal (nasal, adult)
  ('react-health-rio-ii-nasal', 'cushion', 'S', 20, 34, 18, 28, NULL, NULL, NULL, NULL),
  ('react-health-rio-ii-nasal', 'cushion', 'M', 33.1, 38.3, 27.2, 31.5, NULL, NULL, NULL, NULL),
  ('react-health-rio-ii-nasal', 'cushion', 'L', 37.4, 55, 30.8, 45, NULL, NULL, NULL, NULL)
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
-- 11. Invalidate sign-offs on restructured models; bump versions.
-- ---------------------------------------------------------------
-- Per 0511 section 5. A sign-off attests to a specific variant row; the
-- 30i and Evora Full runs had codes renamed and sizes retired underneath
-- theirs, so a prior approval no longer describes what ships.
DELETE FROM "resupply"."mask_variant_reviews" r
USING "resupply"."mask_size_variants" v,
      "resupply"."mask_models" m
WHERE r."size_variant_id" = v."id"
  AND v."mask_model_id" = m."id"
  AND m."org_id" IS NULL
  AND m."slug" IN (
  'fisher-paykel-evora-full',
  'resmed-airfit-f30i',
  'resmed-airfit-f30i-non-magnetic',
  'resmed-airfit-n30i',
  'resmed-airfit-p30i'
);
--> statement-breakpoint

UPDATE "resupply"."mask_models"
SET "catalog_version" = "catalog_version" + 1,
    "updated_at" = now()
WHERE "org_id" IS NULL
  AND "slug" IN (
  'fisher-paykel-evora-full',
  'fisher-paykel-solo',
  'philips-dreamwear-np',
  'philips-dreamwisp',
  'react-health-numa-full-face',
  'react-health-rio-ii',
  'resmed-airfit-f30i',
  'resmed-airfit-f30i-non-magnetic',
  'resmed-airfit-n30i',
  'resmed-airfit-p30i'
);
