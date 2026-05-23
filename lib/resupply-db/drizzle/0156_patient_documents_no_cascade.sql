-- 0156 — change patient_documents.patient_id FK from
--   ON DELETE CASCADE → ON DELETE RESTRICT.
--
-- WHY
-- ---
-- The patient-documents retention sweep
-- (worker/jobs/patient-documents-retention-sweep.ts) treats
-- `legal_hold = true` rows as untouchable, and ordinary
-- destruction is human-triggered via the admin UI with audit
-- entries. A DELETE on the parent `patients` row, however,
-- silently vaporises EVERY child document — including legal-hold
-- evidence — with no audit trail and no sweep involvement.
--
-- There is no admin route that does a parent DELETE today, but a
-- future GDPR right-to-erasure surface (or an operator running
-- ad-hoc SQL) would silently destroy litigation-hold material.
--
-- This migration:
--   1. Drops the existing FK constraint (whatever its current name
--      is — Postgres auto-generated when the column was created).
--   2. Re-adds the FK with ON DELETE RESTRICT.
--
-- A right-to-erasure endpoint will need to walk each child table
-- (patient_documents, prior_authorizations, sleep_studies,
-- insurance_coverages, equipment_assets, etc.) and explicitly
-- apply the per-table retention / legal-hold gate before deleting
-- the parent patient row. That walk is out of scope for this
-- migration — RESTRICT here just ensures an unaudited parent
-- DELETE fails loudly until the walker lands.

DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'resupply.patient_documents'::regclass
    AND contype  = 'f'
    AND pg_get_constraintdef(oid) LIKE '%REFERENCES%resupply.patients%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE resupply.patient_documents DROP CONSTRAINT %I',
      fk_name
    );
  END IF;
END $$;

ALTER TABLE resupply.patient_documents
  ADD CONSTRAINT patient_documents_patient_id_fkey
  FOREIGN KEY (patient_id)
  REFERENCES resupply.patients(id)
  ON DELETE RESTRICT;
