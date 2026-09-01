-- 0539_validate_episode_lifecycle_constraints — finish what 0538 started:
-- turn the two NOT VALID episode CHECKs into validated ones.
--
-- WHY THIS IS A SEPARATE MIGRATION
-- --------------------------------
-- 0538 added `episodes_status_enum` and `episodes_closed_reason_enum` as
-- NOT VALID because 500k+ rows predate the vocabulary and a validating
-- ADD CONSTRAINT would have failed the deploy outright. NOT VALID is
-- widely misread as "applies only to new rows". It is not: Postgres still
-- enforces the constraint on every subsequent INSERT **and UPDATE**,
-- including an UPDATE that never touches the constrained column. A single
-- legacy off-vocabulary row therefore turns the next patient confirm that
-- touches it into a 500, on a patient-facing path, silently.
--
-- So the constraint being unvalidated is not a cosmetic loose end — it is
-- an armed landmine whose blast radius nobody has measured. VALIDATE
-- CONSTRAINT is the measurement: it either succeeds (there were none) or
-- fails naming the first offender.
--
-- SAFETY / LOCKING
-- ----------------
--   * VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the table. It
--     does NOT block SELECT, INSERT, UPDATE or DELETE — only other DDL
--     and VACUUM. Concurrent patient confirms keep working throughout.
--   * It does a single sequential scan. On the current episodes table
--     (hundreds of thousands of rows) that is seconds.
--   * It is skipped entirely when the constraint is already validated, so
--     a re-run is a no-op and a fresh database (where 0538 created the
--     constraint against zero rows) still ends up validated.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
-- It does not rewrite a single historical status. An off-vocabulary
-- `status` records what the system believed happened to a patient's
-- resupply cycle; silently coercing it to the nearest legal spelling
-- would destroy that and make the outcome funnel confidently wrong.
--
-- Instead this migration SURVEYS first and RAISES with the offending
-- values and counts. A failed migration gates the deploy — Railway's
-- preDeployCommand keeps the PREVIOUS release serving, so the cost is a
-- release that does not ship, not an outage. The operator then runs the
-- read-only survey, decides what each value should have been, and repairs
-- deliberately:
--
--     node lib/resupply-db/scripts/constraint-preflight.mjs
--     node lib/resupply-db/scripts/constraint-preflight.mjs --repair-plan
--
-- See docs/runbooks/validate-episode-constraints.md.

DO $$
DECLARE
  offenders text;
  offender_count bigint;
BEGIN
  -- ── episodes.status ────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'episodes_status_enum'
       AND conrelid = 'resupply.episodes'::regclass
       AND convalidated = false
  ) THEN
    SELECT string_agg(DISTINCT "status", ', '), count(*)
      INTO offenders, offender_count
      FROM "resupply"."episodes"
     WHERE "status" NOT IN (
       'outreach_pending', 'awaiting_response', 'address_hold',
       'confirmed', 'fulfilled', 'declined', 'expired', 'canceled'
     );

    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION
        'resupply.episodes.status: % row(s) carry off-vocabulary values (%). '
        'Refusing to validate — these rows already break every UPDATE that '
        'touches them. Survey with lib/resupply-db/scripts/constraint-preflight.mjs '
        'and repair them deliberately; see docs/runbooks/validate-episode-constraints.md.',
        offender_count, offenders;
    END IF;

    ALTER TABLE "resupply"."episodes"
      VALIDATE CONSTRAINT "episodes_status_enum";
    RAISE NOTICE 'validated episodes_status_enum';
  END IF;

  -- ── episodes.closed_reason ─────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'episodes_closed_reason_enum'
       AND conrelid = 'resupply.episodes'::regclass
       AND convalidated = false
  ) THEN
    SELECT string_agg(DISTINCT "closed_reason", ', '), count(*)
      INTO offenders, offender_count
      FROM "resupply"."episodes"
     WHERE "closed_reason" IS NOT NULL
       AND "closed_reason" NOT IN (
         'shipped', 'assumed_shipped',
         'patient_declined', 'patient_opted_out',
         'no_response', 'never_contacted',
         'csr_canceled', 'prescription_ended', 'patient_inactive',
         'duplicate', 'coverage_lost'
       );

    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION
        'resupply.episodes.closed_reason: % row(s) carry off-vocabulary values (%). '
        'Refusing to validate; see docs/runbooks/validate-episode-constraints.md.',
        offender_count, offenders;
    END IF;

    ALTER TABLE "resupply"."episodes"
      VALIDATE CONSTRAINT "episodes_closed_reason_enum";
    RAISE NOTICE 'validated episodes_closed_reason_enum';
  END IF;
END
$$;
