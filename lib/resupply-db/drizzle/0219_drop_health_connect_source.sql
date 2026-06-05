-- Retire the Health Connect (Android patient-push) therapy integration.
--
-- The adapter package (resupply-integrations-health-connect), its
-- registry wiring, the 'health_connect' value in INTEGRATION_SOURCES /
-- TherapyCloudSource, and every UI reference have been removed. This
-- migration takes the value out of the data layer to match.
--
-- Two steps:
--   1. Delete any leftover 'health_connect' rows. The feed never had a
--      live ingest endpoint, so in practice this clears at most a few
--      error-status snapshot rows left behind by manual admin "refresh"
--      clicks; therapy-night / therapy-link rows for the source (if any)
--      go with them. Done FIRST so the tightened CHECK constraints below
--      can be validated without a constraint violation.
--   2. Drop + re-create the three therapy-source CHECK constraints
--      WITHOUT 'health_connect'. Postgres CHECK constraints can't be
--      ALTERed in place; we drop + re-add (guarded by IF EXISTS so
--      re-running the migration is safe). The three allowlists converge
--      on the live therapy sources: resmed_airview, philips_care,
--      react_health (plus 'manual' for nights). This also closes a
--      pre-existing gap where 'react_health' — live on links/nights
--      since 0112 — was never added to the integration_snapshots
--      constraint (that constraint predates 0112; it was created in
--      0065), even though the patient-integrations refresh route writes
--      react_health snapshots.

-- 1. Purge leftover Health Connect rows --------------------------------

DELETE FROM "resupply"."patient_integration_snapshots"
  WHERE "source" = 'health_connect';

DELETE FROM "resupply"."patient_therapy_nights"
  WHERE "source" = 'health_connect';

DELETE FROM "resupply"."patient_therapy_links"
  WHERE "source" = 'health_connect';

-- 2. Tighten the source CHECK constraints ------------------------------

ALTER TABLE "resupply"."patient_therapy_links"
  DROP CONSTRAINT IF EXISTS "patient_therapy_links_source_enum";

ALTER TABLE "resupply"."patient_therapy_links"
  ADD CONSTRAINT "patient_therapy_links_source_enum"
  CHECK ("source" IN (
    'resmed_airview',
    'philips_care',
    'react_health'
  ));

ALTER TABLE "resupply"."patient_therapy_nights"
  DROP CONSTRAINT IF EXISTS "patient_therapy_nights_source_enum";

ALTER TABLE "resupply"."patient_therapy_nights"
  ADD CONSTRAINT "patient_therapy_nights_source_enum"
  CHECK ("source" IN (
    'resmed_airview',
    'philips_care',
    'react_health',
    'manual'
  ));

ALTER TABLE "resupply"."patient_integration_snapshots"
  DROP CONSTRAINT IF EXISTS "patient_integration_snapshots_source_enum";

ALTER TABLE "resupply"."patient_integration_snapshots"
  ADD CONSTRAINT "patient_integration_snapshots_source_enum"
  CHECK ("source" IN (
    'resmed_airview',
    'philips_care',
    'react_health'
  ));
