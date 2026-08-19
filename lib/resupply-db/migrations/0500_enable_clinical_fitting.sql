-- 0500_enable_clinical_fitting — turn the clinical fitting core ON for
-- every tenant, and correct the descriptions that told operators not to.
--
-- Why this reverses 0485
-- ----------------------
-- 0485 seeded `fitter.clinical_assessment` OFF, and said why: "Leave OFF
-- until a respiratory therapist has reviewed the mask geometry for the
-- products you stock." That requirement has been dropped — requiring a
-- clinician to hand-approve ~290 seeded size bands before the fitter
-- could speak confidently made the feature unusable at the scale it
-- exists for. `resolveConfidence` no longer consults
-- `needs_clinical_review` at all (see confidence.ts).
--
-- With the RT sign-off gone, the flag's stated blocker is gone with it,
-- and leaving the engine off would mean the FACE SCAN never chooses the
-- mask: the legacy `/api/recommend` path weights questionnaire answers
-- into mask-TYPE scores and then partitions size linearly across one
-- overall range. The tiered engine behind this flag is the one that
-- matches a patient's millimetre measurements against per-variant bands.
--
-- Which three, and why not the rest
-- ---------------------------------
-- `fitter.clinical_assessment` — the master switch. Without it the
--   other two are inert and /api/fit/assess 404s.
--
-- `fitter.magnet_screening` — turned on TOGETHER with the master switch,
--   deliberately and non-optionally. With the engine on and this off, the
--   magnetic-implant screen never runs (routes/storefront/fit-assess.ts):
--   pacemakers, ICDs and neurostimulators go unasked, and masks with
--   magnetic headgear clips are not excluded on that basis. Enabling the
--   engine without it would be strictly worse than leaving the engine
--   off, so these two move together.
--
-- `fitter.confidence_gating` — also required, for a reason that is easy
--   to miss. With it OFF, `resolveConfidence` skips the plausibility
--   withhold, does NOT honour a capture the client judged unusable, and
--   upgrades every low_confidence result to moderate. That is the exact
--   opposite of letting the scan decide: a physically implausible
--   measurement would still produce a confident-looking answer. Note this
--   is NOT a reinstatement of the sign-off gate — it routes on THIS
--   SCAN's quality, not on whether a clinician has vouched for catalog
--   data.
--
-- Left alone on purpose: `fitter.multiframe_capture` (changes the capture
--   UX — it widens the high-confidence window rather than enabling it; a
--   single frame at quality >= 0.9 already clears the 0.75 scan floor),
--   `fitter.fit_profile_v2` (a longer questionnaire), and
--   `fitter.refit_campaign`. Each stays a deliberate opt-in.
--
-- Safety is unchanged by all of this: tiers 1-2 remain HARD FILTERS
-- (lib/fitting/tiers.ts) that remove contraindicated and
-- therapy-incompatible masks from consideration entirely.
--
-- Future tenants are NOT covered by this migration — onboarding copies
-- the seed org's flags or applies a plan preset, and these three keys sat
-- in DELIBERATELY_OFF_FLAGS. That is changed in the same commit, in
-- lib/resupply-domain/src/feature-flag-presets.ts.
--
-- Per ADR 003 — versioned hand-authored migration.

UPDATE "resupply"."feature_flags"
SET "enabled" = true,
    "description" = 'Master switch for the clinical fitting core. ON: the mask fitter '
      || 'reads the Mask Intelligence Catalog and this tenant''s formulary '
      || 'from the database, runs the tiered recommendation engine (safety, '
      || 'then therapy compatibility, then facial fit, then patient '
      || 'preferences, then formulary, then inventory), and records a fit '
      || 'session with full provenance. OFF: the fitter falls back to the '
      || 'built-in catalog and the legacy questionnaire-weighted engine, '
      || 'which does not match measurements against per-variant size bands.'
WHERE "key" = 'fitter.clinical_assessment';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "enabled" = true,
    "description" = 'Magnetic-component safety screening for the patient and their '
      || 'household, using the version-controlled question set. A positive '
      || 'or unsure answer excludes every mask with magnetic headgear clips '
      || 'and surfaces non-magnetic alternatives. Requires '
      || 'fitter.clinical_assessment — and should be left ON whenever it '
      || 'is, since the engine cannot screen for implants without it.'
WHERE "key" = 'fitter.magnet_screening';
--> statement-breakpoint

UPDATE "resupply"."feature_flags"
SET "enabled" = true,
    "description" = 'Confidence-driven exception handling. Low-confidence fittings stop '
      || 'short of an automated recommendation and ask for a better scan or '
      || 'a review instead of guessing; a measurement outside the plausible '
      || 'range for a face is reported as a scan failure; a prescribed '
      || 'pressure above a mask''s rated maximum becomes an exclusion '
      || 'rather than a scoring penalty. Requires '
      || 'fitter.clinical_assessment. This gates on the QUALITY OF THE '
      || 'SCAN, not on clinician sign-off of the catalog.'
WHERE "key" = 'fitter.confidence_gating';
