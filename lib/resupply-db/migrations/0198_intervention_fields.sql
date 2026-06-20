-- 0198_intervention_fields — RT #21: structured non-adherence
-- intervention plan + outcome tracking.
--
-- F3's clinical_encounters already carries the free-text intervention
-- fields (reason / assessment / intervention / plan / follow_up_at) and
-- the 'adherence_intervention' encounter_type + linked_alert_id. What it
-- lacks is STRUCTURE: a queryable "why did usage drop?" category and a
-- "did the plan work?" outcome. Those two columns turn a pile of
-- free-text notes into something the RT worklist can rank and the team
-- can learn from.
--
--   * assessment_category — the structured reason a patient fell off
--     therapy. CHECK-constrained taxonomy. NULLABLE (only interventions
--     set it; other encounter types leave it null).
--
--   * outcome_status — whether the intervention worked, recorded by the
--     RT on a later re-check. 'pending' until assessed; then improved /
--     no_change / worsened / unknown. NULLABLE (non-interventions leave
--     it null). This is the MANUAL re-check — the automated
--     therapy-metric before/after comparison is a separate follow-up.
--
-- Both columns live on clinical_encounters (interventions ARE encounter
-- rows of type 'adherence_intervention', so they also appear in the
-- existing patient clinical timeline — no parallel table, no data
-- duplication). Additive, no backfill. Per ADR 003 — versioned
-- hand-authored migration.

ALTER TABLE "resupply"."clinical_encounters"
  ADD COLUMN IF NOT EXISTS "assessment_category" text;
--> statement-breakpoint
ALTER TABLE "resupply"."clinical_encounters"
  ADD COLUMN IF NOT EXISTS "outcome_status" text;
--> statement-breakpoint

ALTER TABLE "resupply"."clinical_encounters"
  DROP CONSTRAINT IF EXISTS "clinical_encounters_assessment_category_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."clinical_encounters"
  ADD CONSTRAINT "clinical_encounters_assessment_category_enum"
  CHECK ("assessment_category" IS NULL OR "assessment_category" IN (
    'mask_leak',
    'claustrophobia',
    'pressure_intolerance',
    'motivation',
    'congestion',
    'mask_discomfort',
    'mouth_breathing',
    'travel_disruption',
    'other'
  ));
--> statement-breakpoint

ALTER TABLE "resupply"."clinical_encounters"
  DROP CONSTRAINT IF EXISTS "clinical_encounters_outcome_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."clinical_encounters"
  ADD CONSTRAINT "clinical_encounters_outcome_status_enum"
  CHECK ("outcome_status" IS NULL OR "outcome_status" IN (
    'pending',
    'improved',
    'no_change',
    'worsened',
    'unknown'
  ));
--> statement-breakpoint

-- The intervention worklist scans by outcome_status (open = 'pending').
CREATE INDEX IF NOT EXISTS "clinical_encounters_outcome_status_idx"
  ON "resupply"."clinical_encounters" ("outcome_status");
