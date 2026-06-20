-- Extend the therapy-source enum CHECK constraints to include
-- React Health (3B Medical iCode Connect) — third CPAP-cloud
-- integration alongside ResMed AirView and Philips Care
-- Orchestrator.
--
-- Postgres CHECK constraints can't be ALTERed in place; we drop +
-- re-create with the wider allowlist. Both writes are guarded by
-- IF EXISTS so re-running the migration is safe.

ALTER TABLE "resupply"."patient_therapy_links"
  DROP CONSTRAINT IF EXISTS "patient_therapy_links_source_enum";

ALTER TABLE "resupply"."patient_therapy_links"
  ADD CONSTRAINT "patient_therapy_links_source_enum"
  CHECK ("source" IN (
    'resmed_airview',
    'philips_care',
    'health_connect',
    'react_health'
  ));

ALTER TABLE "resupply"."patient_therapy_nights"
  DROP CONSTRAINT IF EXISTS "patient_therapy_nights_source_enum";

ALTER TABLE "resupply"."patient_therapy_nights"
  ADD CONSTRAINT "patient_therapy_nights_source_enum"
  CHECK ("source" IN (
    'resmed_airview',
    'philips_care',
    'health_connect',
    'react_health',
    'manual'
  ));
