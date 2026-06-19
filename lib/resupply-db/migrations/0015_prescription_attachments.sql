-- Prescription document attachments (Admin Phase 4 / W4 T-C4).
--
-- Why object storage rather than a Postgres bytea column:
--   Prescription scans are typically 200KB–4MB image/PDF blobs. A
--   dedicated Postgres column would bloat backup/restore size and
--   force the encryption key set we use for inline PHI to also
--   protect documents that already have GCS-side AES-256 at rest.
--   We instead store only the GCS object path here and rely on the
--   storage layer's ACL framework + presigned-URL flow for access
--   control (see artifacts/resupply-api/src/lib/objectStorage.ts and
--   objectAcl.ts). The mapping {prescriptionId -> objectKey} is what
--   makes the document discoverable; without it the GCS object is
--   orphaned and unreachable.
--
-- Why these specific columns:
--   * attachment_object_key: GCS path inside PRIVATE_OBJECT_DIR
--     (e.g. "/objects/uploads/<uuid>"). Stored as TEXT, NOT a URL,
--     so we can rotate the bucket / hostname without an audit-trail
--     rewrite.
--   * attachment_filename: customer-facing original filename
--     captured at upload time. NOT trusted (browser-supplied) but
--     useful for "Download Rx_Smith_2026-04.pdf" UX. Capped at 255
--     to bound display + storage cost.
--   * attachment_content_type: validated MIME type (we restrict to
--     image/* + application/pdf at the route layer). Persisted so
--     the download endpoint can set Content-Type correctly without
--     re-deriving from filename extension.
--   * attachment_size_bytes: redundant with GCS metadata but cheap
--     to materialize here for list rendering ("Smith Rx (1.2 MB)")
--     without a per-row metadata round-trip to GCS.
--   * attachment_uploaded_at: distinct from prescriptions.updated_at
--     because status transitions (active → expired → revoked) also
--     bump updated_at and we want to render "Document attached
--     YYYY-MM-DD" without that column lying.
--
-- Pure additive, all nullable. Existing prescriptions simply have no
-- attachment until one is uploaded. No backfill, no defaults — a
-- prescription without an attachment is a valid steady state and
-- always will be (some prescriptions originated by phone never have
-- a document scan).
--
-- Per ADR 003 — versioned hand-authored migration; this codebase
-- does not use db:push because db:push silently rewrites columns
-- once PHI lands.

ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "attachment_object_key" text,
  ADD COLUMN IF NOT EXISTS "attachment_filename" varchar(255),
  ADD COLUMN IF NOT EXISTS "attachment_content_type" varchar(120),
  ADD COLUMN IF NOT EXISTS "attachment_size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "attachment_uploaded_at" timestamp with time zone;
