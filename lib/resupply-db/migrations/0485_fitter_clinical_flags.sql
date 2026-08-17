-- 0485_fitter_clinical_flags — feature flags for the clinical fitting core.
--
-- Every flag that changes what a PATIENT sees is seeded OFF, so this
-- whole migration set is inert until a tenant is deliberately switched
-- on. The one flag seeded ON is staff-only and purely additive.
--
-- Rollout order matters and is encoded in the descriptions:
--   fitter.clinical_assessment  must precede everything else — it is
--     what makes the engine read the DB catalog + formulary at all.
--   fitter.magnet_screening     needs the 0484 seed.
--   fitter.confidence_gating    needs 0483 (somewhere to route a review).
--   fitter.multiframe_capture   is independent of the server work.
--
-- fitter.clinical_assessment is deliberately OFF even though the catalog
-- ships seeded: the seeded facial-geometry bands are ESTIMATED and every
-- row lands needs_clinical_review = true. A tenant should not run on
-- them until an RT has signed off the variants that tenant actually
-- stocks. (The engine independently caps an unreviewed variant below
-- high confidence, so the flag is the second line of defence, not the
-- only one.)
--
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts — a key here that is
-- missing there silently no-ops in the admin toggle UI.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('fitter.clinical_assessment',
   false,
   'Master switch for the clinical fitting core. ON: the mask fitter '
     || 'reads the Mask Intelligence Catalog and this tenant''s '
     || 'formulary from the database, runs the tiered recommendation '
     || 'engine (safety, then therapy compatibility, then facial fit, '
     || 'then patient preferences, then formulary, then inventory), and '
     || 'records a fit session with full provenance. OFF: the fitter '
     || 'behaves exactly as before, using the built-in catalog. Leave '
     || 'OFF until a respiratory therapist has reviewed the mask '
     || 'geometry for the products you stock (Fitter > Mask Catalog > '
     || 'Needs review).',
   'Clinical'),
  ('fitter.multiframe_capture',
   false,
   'Guided multi-angle scan capture with live quality checks (lighting, '
     || 'distance, head position, obstruction, movement) and '
     || 'cross-frame measurement agreement. Produces a measurement '
     || 'confidence score instead of a single unverified snapshot. OFF: '
     || 'single-frame capture as before.',
   'Clinical'),
  ('fitter.fit_profile_v2',
   false,
   'The expanded Patient Fit Profile — around 20 questions across six '
     || 'short chapters (therapy, breathing, sleep and comfort, face '
     || 'and skin, history and handling, safety) with branching so the '
     || 'typical patient answers far fewer. OFF: the original 11 '
     || 'questions.',
   'Clinical'),
  ('fitter.magnet_screening',
   false,
   'Magnetic-component safety screening for the patient and their '
     || 'household, using the version-controlled question set. A '
     || 'positive or unsure answer excludes every mask with magnetic '
     || 'headgear clips and surfaces non-magnetic alternatives. '
     || 'Requires fitter.clinical_assessment.',
   'Clinical'),
  ('fitter.confidence_gating',
   false,
   'Confidence-driven exception handling. Low-confidence fittings stop '
     || 'short of an automated recommendation and ask for a better scan '
     || 'or a respiratory therapist review instead of guessing; a '
     || 'prescribed pressure above a mask''s rated maximum becomes an '
     || 'exclusion rather than a scoring penalty. Requires '
     || 'fitter.clinical_assessment.',
   'Clinical'),
  ('fitter.clinical_report',
   true,
   'The downloadable clinical fit report (PDF) for staff, covering scan '
     || 'quality, questionnaire answers, safety screening, '
     || 'measurements, the recommendation and its alternatives, '
     || 'formulary and rules versions, clinician approval or override, '
     || 'and the full session history. Staff-only and additive — safe '
     || 'to leave on.',
   'Clinical')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
