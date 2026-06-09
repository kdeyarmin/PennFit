-- 0252_manual_documents — staff-authored, manually-typed PDF documents.
--
-- CSRs need to produce one-off documents (Certificate of Medical
-- Necessity, prescription/order, agreement/consent, delivery ticket,
-- fax cover letter, or a free-form letter) by TYPING the content
-- themselves — deliberately WITHOUT pre-populating any patient record.
-- The same row can later be emailed to a customer, faxed, and/or
-- attached to a patient chart, but none of those are required: a
-- document can exist on its own.
--
-- Content model: a per-type field catalog (artifacts/resupply-api/
-- src/lib/manual-documents/catalog.ts) drives the editable form and the
-- PDF renderer. The typed values live in `fields` (jsonb, key→string),
-- plus a shared recipient block (recipient_*) and a free-form `body`.
-- Nothing here is auto-filled from resupply.patients — `patient_id` is
-- only set when a staff member explicitly files the rendered PDF to a
-- chart (which also inserts a resupply.patient_documents row so the
-- document surfaces in the patient's Documents tab).
--
-- Lifecycle (status):
--   draft    — being authored / edited.
--   sent     — emailed and/or faxed to a recipient at least once.
--   attached — the rendered PDF was filed to a patient chart.
-- The status is a coarse "most-advanced action taken" marker; a doc can
-- still be edited and re-sent after either transition.
--
-- Plain table (no RLS) — service-role client only. PHI: the typed
-- content and recipient contact. Governed by the same service-role
-- boundary as the rest of resupply.* and the optional patient FK. Per
-- ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."manual_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Catalog key (cmn | prescription | agreement | delivery_ticket |
  -- cover_letter | other). Validated against the catalog at the route
  -- layer; the CHECK is a belt-and-suspenders guard against bad writes.
  "document_type" text NOT NULL,
  "title" text NOT NULL,
  -- Shared recipient block — all typed by the author, never pulled from
  -- a patient record.
  "recipient_name" text,
  "recipient_address" text,
  "recipient_email" text,
  "recipient_fax_e164" text,
  -- Per-type typed fields (key→string). The catalog defines which keys
  -- a given document_type renders; unknown keys are ignored on render.
  "fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Free-form body / notes that render below the structured fields.
  "body" text,
  -- Linked chart. NULL until a staff member files the PDF to a chart.
  -- ON DELETE SET NULL so deleting a chart doesn't erase the document.
  "patient_id" uuid REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  -- The resupply.patient_documents row created when filed to a chart.
  -- No FK (patient_documents rows are reaped by the retention sweep);
  -- this is a soft pointer so the UI can show "filed".
  "chart_document_id" uuid,
  "status" text NOT NULL DEFAULT 'draft',
  "last_emailed_at" timestamp with time zone,
  "last_faxed_at" timestamp with time zone,
  "attached_at" timestamp with time zone,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "manual_documents_document_type_chk"
    CHECK ("document_type" IN (
      'cmn', 'prescription', 'agreement', 'delivery_ticket',
      'cover_letter', 'other'
    )),
  CONSTRAINT "manual_documents_status_chk"
    CHECK ("status" IN ('draft', 'sent', 'attached'))
);
--> statement-breakpoint
-- Library list sorts/filters by status, newest first.
CREATE INDEX IF NOT EXISTS "manual_documents_status_created_idx"
  ON "resupply"."manual_documents" ("status", "created_at" DESC);
--> statement-breakpoint
-- A patient chart → its filed manual documents.
CREATE INDEX IF NOT EXISTS "manual_documents_patient_id_idx"
  ON "resupply"."manual_documents" ("patient_id");
