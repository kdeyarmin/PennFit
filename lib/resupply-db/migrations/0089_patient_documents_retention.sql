-- patient_documents: HIPAA retention automation (Phase 1).
-- See lib/resupply-db/src/schema/patient-documents.ts for the
-- column rationale: retention_until_at + legal_hold drive the
-- nightly sweep; retention_marked_at + destroyed_at + destroyed_
-- by_admin_id keep the human-step destruction audit-friendly.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "retention_until_at" timestamp with time zone;

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "legal_hold" boolean NOT NULL DEFAULT false;

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "retention_marked_at" timestamp with time zone;

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "destroyed_at" timestamp with time zone;

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "destroyed_by_admin_id" text
    REFERENCES "resupply"."admin_users"("id") ON DELETE SET NULL;

-- Hot path for the nightly sweep: rows whose retention has passed
-- AND haven't been flagged yet AND aren't on legal hold. Partial
-- index keeps the worker scan cheap.
CREATE INDEX IF NOT EXISTS "patient_documents_retention_sweep_idx"
  ON "resupply"."patient_documents" ("retention_until_at")
  WHERE retention_marked_at IS NULL
    AND destroyed_at IS NULL
    AND legal_hold = false;
