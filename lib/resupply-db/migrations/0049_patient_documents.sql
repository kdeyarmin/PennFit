-- Patient-uploaded documents (patient portal document upload feature).
--
-- Why a new table rather than extending prescriptions or messages:
--   Prescriptions use inline attachment columns (migration 0015) — that
--   pattern works for a 1:1 doc-per-row relationship. Patient portal
--   documents are M:1 (a patient may upload multiple insurance cards,
--   referrals, etc.) so we need a dedicated table with a patient_id FK.
--   Message attachments are inbound-only and tied to a conversation
--   thread; patient documents exist outside any conversation.
--
-- document_type is stored as a short enum string validated at the
-- route layer. Stored as varchar rather than a Postgres enum so we
-- can add new categories (migration-free) by updating the server-side
-- allowlist.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_documents" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id"     uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "object_key"     text NOT NULL,
  "document_type"  varchar(64) NOT NULL,
  "filename"       varchar(255),
  "content_type"   varchar(120) NOT NULL,
  "size_bytes"     integer NOT NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "patient_documents_patient_idx"
  ON "resupply"."patient_documents" ("patient_id");
