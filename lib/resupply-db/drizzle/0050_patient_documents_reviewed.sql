-- Patient document review tracking (enhancement to 0049).
--
-- Two new nullable columns on patient_documents:
--   reviewed_at      — when a CSR first opened / acknowledged the doc.
--   reviewed_by_admin_id — which admin user marked it reviewed
--     (references admin_users so we can surface the reviewer's name
--     in audit queries; nullable because the admin row may not exist
--     in every deployment and we'd rather show the doc than crash).
--
-- Partial index on (patient_id) WHERE reviewed_at IS NULL drives the
-- inbox-counts "unreviewed documents" subquery without scanning the
-- full history.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN "reviewed_at"       timestamp with time zone,
  ADD COLUMN "reviewed_by_admin_id" text
    REFERENCES "resupply"."admin_users"("id") ON DELETE SET NULL;

-- Fast inbox-counts query: unreviewed docs per patient.
CREATE INDEX IF NOT EXISTS "patient_documents_unreviewed_idx"
  ON "resupply"."patient_documents" ("patient_id")
  WHERE "reviewed_at" IS NULL;
