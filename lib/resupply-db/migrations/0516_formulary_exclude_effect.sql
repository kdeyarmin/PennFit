-- 0516_formulary_exclude_effect — let a DME hide a manufacturer outright.
--
-- Why
-- ---
-- 0482 gave the formulary four effects: allow, deny, prefer, deprioritize.
-- `deny` is deliberately ADVISORY — the resolver returns `allowed: false`
-- but the ranking pipeline keeps the candidate, demoted and tagged, so
-- that when the clinical tiers leave only out-of-formulary options a
-- clinician still sees the best one. That is the right behaviour for
-- "we would rather not dispense this".
--
-- It is the WRONG behaviour for "we do not carry this at all". A DME that
-- has dropped a manufacturer on price does not want that manufacturer's
-- masks surfacing anywhere — not demoted, not flagged, not at the bottom
-- of a list a patient scrolls. Showing a patient a mask the provider
-- cannot dispense is its own kind of harm: it sets an expectation the
-- provider then has to walk back.
--
-- So this adds a FIFTH effect, `exclude`, and the distinction between it
-- and `deny` is the whole point:
--
--   deny    — demote and tag. Clinical safety net preserved: the mask can
--             still surface, flagged, when nothing else survives.
--   exclude — hard hide. The mask is removed from the candidate pool and
--             from every patient-facing catalog and search surface,
--             because the provider genuinely does not stock it.
--
-- Precedence, inside the tier the existing scope/target specificity
-- machinery already picks: exclude > deny > allow. A MORE SPECIFIC allow
-- still wins over a broader exclude, which is what makes
-- "exclude manufacturer=ResMed, allow mask_model=AirFit F20" express
-- "we dropped ResMed except for the one model we still stock" — target
-- specificity (mask_model 3 > manufacturer 1) does that for free.
--
-- THE SAFETY POSTURE IS UNCHANGED
-- -------------------------------
-- `exclude` REMOVES options; it can never add one. The resolver is still
-- handed only candidates that already survived tiers 1-2, so a formulary
-- decision of any kind still cannot resurrect a clinical or safety
-- exclusion. What is new is the failure mode in the other direction —
-- hiding so much that a patient has nothing left — and that is guarded
-- where it belongs, in the app: the publish pre-flight
-- (`formulary_would_exclude_all`) and the manufacturer-visibility
-- endpoint both refuse a configuration that empties the synthetic panel,
-- and an empty candidate set still resolves to the existing withheld
-- outcome rather than a blank page.
--
-- Excluded masks are recorded in the fit session's provenance
-- (`formularyExcludedSlugs`) for the clinician and the audit trail, and
-- are stripped from the patient projection — the patient should not see a
-- list of what their provider chose not to carry.
--
-- PHI: none. Formulary configuration is business data.
--
-- Per ADR 003 — versioned hand-authored migration. No data is rewritten:
-- this only widens a CHECK constraint, so every existing rule keeps its
-- exact meaning and behaviour.

ALTER TABLE "resupply"."formulary_rules"
  DROP CONSTRAINT IF EXISTS "formulary_rules_effect_chk";
--> statement-breakpoint

ALTER TABLE "resupply"."formulary_rules"
  ADD CONSTRAINT "formulary_rules_effect_chk"
  CHECK ("effect" IN ('allow', 'deny', 'exclude', 'prefer', 'deprioritize'));
--> statement-breakpoint

-- The manufacturer-visibility toggle writes exactly one org-wide rule per
-- hidden manufacturer, and the "is this manufacturer hidden?" read runs on
-- every fitting and every public catalog request. Partial index so it
-- covers only the rows that toggle actually creates.
CREATE INDEX IF NOT EXISTS "formulary_rules_exclude_manufacturer_idx"
  ON "resupply"."formulary_rules"
     ("org_id", "formulary_id", "target_manufacturer")
  WHERE "effect" = 'exclude' AND "target_kind" = 'manufacturer';
