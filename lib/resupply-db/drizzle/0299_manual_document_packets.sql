-- 0294_manual_document_packets — bundle manual documents into a packet.
--
-- Staff on /admin/documents author one-off documents (CMN, prescription,
-- agreement, delivery ticket, fax cover, free-form letter — see
-- 0252_manual_documents). Each can already be sent individually; a
-- packet bundles several of them into ONE combined PDF (optional
-- generated cover sheet + each document starting on a fresh page) that
-- is emailed or faxed as a single transmission.
--
-- Content model: `document_ids` is an ORDERED jsonb array of
-- resupply.manual_documents ids (the packet's page order). A join table
-- is deliberately avoided — packets are small (≤25 documents), the
-- runtime data path is PostgREST, and ordering lives naturally in the
-- array. Member documents are loaded by id at render time; a deleted
-- member surfaces as an explicit "missing" error rather than a silently
-- shorter packet.
--
-- Lifecycle (status):
--   draft — being assembled / edited.
--   sent  — emailed and/or faxed at least once (can be edited + re-sent).
--
-- Plain table (no RLS) — service-role client only. PHI: the recipient
-- contact block (member-document content stays in manual_documents).
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."manual_document_packets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  -- Shared recipient block — typed by the author, never pulled from a
  -- patient record (same posture as manual_documents).
  "recipient_name" text,
  "recipient_address" text,
  "recipient_email" text,
  "recipient_fax_e164" text,
  -- Ordered array of resupply.manual_documents ids (jsonb array of
  -- uuid strings). Validated at the route layer.
  "document_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Render a generated cover sheet (title + recipient + contents list)
  -- as the packet's first page. Off when the author bundles their own
  -- cover_letter document instead.
  "include_cover_sheet" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'draft',
  "last_emailed_at" timestamp with time zone,
  "last_faxed_at" timestamp with time zone,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "manual_document_packets_status_chk"
    CHECK ("status" IN ('draft', 'sent'))
);
--> statement-breakpoint
-- Packets list sorts/filters by status, newest first.
CREATE INDEX IF NOT EXISTS "manual_document_packets_status_created_idx"
  ON "resupply"."manual_document_packets" ("status", "created_at" DESC);
