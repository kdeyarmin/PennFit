-- 0253_signature_tracking — track every document sent out for a
-- provider signature until it is returned signed.
--
-- The problem
-- -----------
-- Several document kinds get faxed/handed to a prescriber to sign and
-- return: the pre-populated prescription-request packet
-- (resupply.prescription_request_packets) and staff-authored manual
-- documents that require a signature (resupply.manual_documents of type
-- cmn / prescription / agreement / delivery_ticket). Before this table
-- each kind tracked its own lifecycle in isolation, so there was no
-- single "what is still out for signature?" view, and a signed fax that
-- came back was filed by hand with no machine-readable hook to say which
-- document it belonged to.
--
-- What this is
-- -----------
-- A thin, kind-agnostic tracking ledger. One row is created when a
-- document is first prepared/sent for signature. The row carries a short
-- human-keyable `tracking_code` (e.g. PFS-7F3K2Q9X) that is ALSO printed
-- as a Code 128 barcode on the outgoing PDF (see
-- artifacts/resupply-api/src/lib/barcode/code128.ts). When the signed
-- copy is faxed back, staff scan (or type) that code to instantly pull
-- the document up and mark it returned — and the unified
-- /admin/signature-tracking dashboard shows everything still outstanding,
-- grouped by provider/practice, so the queue can be worked at a glance.
--
-- This table does NOT own the document content — that stays on the source
-- row (prescription_request_packets / manual_documents). `document_kind`
-- + `document_id` is a SOFT pointer (no cross-kind FK is possible). The
-- provider/practice/patient/title columns are SNAPSHOTS taken at
-- registration time so the dashboard renders without re-joining (and
-- still reads sensibly if a source row is later edited or a provider
-- record is repointed). patient_id / provider_id keep real FKs (ON DELETE
-- SET NULL) so a deleted chart/provider degrades gracefully rather than
-- orphaning.
--
-- Lifecycle (status):
--   awaiting_signature — out for signature (the outstanding queue).
--   returned_signed    — the signed copy came back and was logged.
--   canceled           — the request was voided / no longer needed.
--
-- Plain table (no RLS) — service-role client only. PHI: the snapshot
-- labels (patient name, provider name) are PHI; governed by the same
-- service-role boundary as the rest of resupply.*. Per ADR 003 —
-- versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."signature_tracking" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short, human-keyable, barcode-encoded handle for the physical
  -- document. Unique so a scanned/typed code resolves to exactly one row.
  "tracking_code" text NOT NULL,
  -- Which source table the document lives in, and its id there. Soft
  -- pointer: no cross-kind FK exists, so this is enforced at the app
  -- layer. The (kind, id) pair is unique — one tracking row per document.
  "document_kind" text NOT NULL,
  "document_id" uuid NOT NULL,
  -- Real FKs (ON DELETE SET NULL) for the chart + prescriber, when known.
  "patient_id" uuid REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "provider_id" uuid REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  -- Snapshots captured at registration so the dashboard renders without
  -- re-joining and stays readable if the source row later changes.
  "patient_label" text,
  "provider_label" text,
  "practice_name" text,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'awaiting_signature',
  -- How it was most recently sent out (fax | email | hand_delivery | none).
  "delivery_channel" text NOT NULL DEFAULT 'none',
  -- Where the signed copy is expected back (printed in the dashboard so a
  -- CSR can resend without opening the source doc).
  "return_fax_e164" text,
  -- How many times it has been dispatched (re-sends bump this).
  "sent_count" integer NOT NULL DEFAULT 0,
  "last_sent_at" timestamp with time zone,
  "returned_at" timestamp with time zone,
  "canceled_at" timestamp with time zone,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "signature_tracking_document_kind_chk"
    CHECK ("document_kind" IN ('prescription_request', 'manual_document')),
  CONSTRAINT "signature_tracking_status_chk"
    CHECK ("status" IN ('awaiting_signature', 'returned_signed', 'canceled')),
  CONSTRAINT "signature_tracking_delivery_channel_chk"
    CHECK ("delivery_channel" IN ('none', 'fax', 'email', 'hand_delivery'))
);
--> statement-breakpoint
-- A scanned/typed barcode resolves to exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS "signature_tracking_code_uq"
  ON "resupply"."signature_tracking" ("tracking_code");
--> statement-breakpoint
-- One tracking row per source document; lets the register step upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "signature_tracking_document_uq"
  ON "resupply"."signature_tracking" ("document_kind", "document_id");
--> statement-breakpoint
-- The outstanding-queue read: every row still awaiting a signature,
-- oldest first. Partial so the index stays small as rows are cleared.
CREATE INDEX IF NOT EXISTS "signature_tracking_outstanding_idx"
  ON "resupply"."signature_tracking" ("created_at")
  WHERE "status" = 'awaiting_signature';
--> statement-breakpoint
-- Group-by-provider and group-by-practice dashboard reads.
CREATE INDEX IF NOT EXISTS "signature_tracking_provider_idx"
  ON "resupply"."signature_tracking" ("provider_id")
  WHERE "status" = 'awaiting_signature';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signature_tracking_practice_idx"
  ON "resupply"."signature_tracking" ("practice_name")
  WHERE "status" = 'awaiting_signature';
