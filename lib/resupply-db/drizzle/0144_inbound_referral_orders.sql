-- 0144_inbound_referral_orders — typed referral inbox for inbound
-- electronic DME orders.
--
-- Sits downstream of `inbound_webhooks` (0138). The raw webhook lands
-- in `inbound_webhooks` first; a per-source dispatcher
-- (lib/inbound-dispatchers/parachute.ts) parses it into a typed
-- referral row here and mirrors any attached documents into
-- `inbound_referral_documents`. The CSR triage queue
-- (/admin/inbound-referrals — landing in a follow-up commit) lists
-- these rows and walks them through the same state machine the
-- inbound-fax queue uses.
--
-- Triage state machine — identical shape to inbound_faxes (0077) so
-- the admin UI can share components:
--   new      -> triaged | accepted | rejected | duplicate | archived
--   triaged  -> accepted | rejected | archived | new
--   accepted -> archived              (terminal-ish; mirrors fax `attached`)
--   rejected -> archived | new        (back-out path for misclassifications)
--   duplicate -> archived             (dedupe terminal)
--   archived -> new                   (resurrect)
--
-- The `accepted` transition requires `accepted_order_id` to be set
-- in the same PATCH (enforced in the route, not at the DB level —
-- Postgres lacks conditional NOT NULL).
--
-- PHI posture: hcpcs_items_json + icd10_codes_json hold clinical
-- data; raw_parsed_json holds the source-verbatim payload. Loggers
-- emit referral ids + source slugs only, never these fields.
--
-- Per ADR 003 — versioned hand-authored migration. New table; safe
-- to re-apply via IF NOT EXISTS.

-- ────────────────────────────────────────────────────────────────────
-- 1. inbound_referral_orders — typed referral inbox row
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."inbound_referral_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Source slug — 'parachute' | 'ehr_fhir_<tenant>' | etc. Matches
  -- inbound_webhooks.source one-for-one.
  "source" varchar(40) NOT NULL,
  -- The source's own order identifier. UNIQUE per source so a
  -- re-delivered webhook lands at-most-once. Sized for opaque GUID-
  -- shaped IDs with headroom.
  "source_order_id" varchar(120) NOT NULL,
  -- FK back to the verbatim webhook row that produced this referral.
  -- ON DELETE SET NULL because we may archive the raw inbox row long
  -- before the typed referral. The dispatcher writes the FK at parse
  -- time.
  "inbound_webhook_id" uuid
    REFERENCES "resupply"."inbound_webhooks"("id") ON DELETE SET NULL,
  -- Patient / provider matches. Populated by Phase 2 matchers
  -- (DOB+last-name+phone for patient, NPI for provider) — nullable
  -- on insert so Phase 1 lands the row even when matching has not
  -- yet run. ON DELETE SET NULL so deleting a patient never deletes
  -- the audit-of-record referral.
  "patient_match_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "provider_match_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  -- Free-form payer name as the source presented it. Resolution into
  -- a real payer FK happens at accept time.
  "payer_name" text,
  -- The ordering clinician's NPI as the source presented it. We
  -- store the raw string here even when provider_match_id is set so
  -- "what did the upstream system claim?" remains queryable forever.
  "ordering_npi" varchar(10),
  -- Itemised HCPCS lines: [{ code, modifier, quantity, description }].
  "hcpcs_items_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Diagnosis codes: ['G47.33', ...]. Strings, not codes — sources
  -- vary in punctuation.
  "icd10_codes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Source-verbatim parsed JSON — what the parser produced after
  -- normalisation. NOT the raw webhook body (that's
  -- inbound_webhooks.payload_json). Lets a future parser change be
  -- replayed against history.
  "raw_parsed_json" jsonb NOT NULL,
  -- Triage state machine (see header).
  "triage_status" text NOT NULL DEFAULT 'new',
  "assigned_admin_user_id" uuid,
  "triaged_at" timestamp with time zone,
  "triaged_by_user_id" uuid,
  -- When triage_status='accepted', this points at the shop_orders /
  -- episodes / patient_documents row the CSR materialised. Polymorphic
  -- on purpose — different referral kinds (new patient, refill) end
  -- up creating different records. Pair with accepted_order_kind so
  -- we can resolve the row.
  "accepted_order_id" uuid,
  "accepted_order_kind" varchar(40),
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid,
  -- Free-form CSR triage note.
  "notes" text,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_referral_orders_triage_status_enum"
    CHECK ("triage_status" IN (
      'new', 'triaged', 'accepted', 'rejected', 'duplicate', 'archived'
    ))
);
--> statement-breakpoint

-- Dedupe: a re-delivered webhook for the same source_order_id is a
-- no-op upsert. Matches the inbound_webhooks (source, dedupe_key)
-- pattern one level up.
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_referral_orders_source_order_uq"
  ON "resupply"."inbound_referral_orders" ("source", "source_order_id");
--> statement-breakpoint

-- Triage queue lookup — list open referrals oldest-first (same shape
-- as inbound_faxes_status_received_at_idx).
CREATE INDEX IF NOT EXISTS "inbound_referral_orders_status_received_idx"
  ON "resupply"."inbound_referral_orders" ("triage_status", "received_at")
  WHERE "triage_status" NOT IN ('archived', 'rejected', 'duplicate');
--> statement-breakpoint

-- Patient-detail surface filter — "all referrals already linked to
-- this patient".
CREATE INDEX IF NOT EXISTS "inbound_referral_orders_patient_idx"
  ON "resupply"."inbound_referral_orders" ("patient_match_id")
  WHERE "patient_match_id" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. inbound_referral_documents — clinical attachments
-- ────────────────────────────────────────────────────────────────────
--
-- Parachute (and EHR partners) send Rx, F2F evals, sleep studies,
-- chart notes alongside the order. The parser drops one row per
-- attachment here; the dispatcher mirrors each file into object
-- storage (same path the fax media pipeline uses). At `accept` time
-- these rows get linked to prescriptions / patient_documents.
CREATE TABLE IF NOT EXISTS "resupply"."inbound_referral_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE,
  -- Free-form classification the source supplied: 'prescription',
  -- 'face_to_face', 'sleep_study', 'chart_note', 'cmn', 'other'.
  -- Enforced in the dispatcher, not the DB, because new sources may
  -- introduce new kinds and we want them to land rather than reject.
  "doc_kind" varchar(40) NOT NULL,
  -- Filename as the source presented it (for display only).
  "source_filename" text,
  "content_type" varchar(120),
  "size_bytes" integer,
  -- Object-storage key — populated after the dispatcher mirrors the
  -- file from the source's CDN into our bucket. Nullable until
  -- mirror completes; the dispatcher retries on failure.
  "object_key" text,
  -- The source's stable URL for the file. Persisted so a CSR can
  -- click through if the mirror has not yet completed.
  "source_url" text,
  -- The source's own document identifier — used for dedupe within a
  -- single referral.
  "source_document_id" varchar(120),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_referral_documents_size_non_negative"
    CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0)
);
--> statement-breakpoint

-- Dedupe attachments within a single referral.
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_referral_documents_referral_doc_uq"
  ON "resupply"."inbound_referral_documents"
  ("referral_id", "source_document_id")
  WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inbound_referral_documents_referral_idx"
  ON "resupply"."inbound_referral_documents" ("referral_id");
