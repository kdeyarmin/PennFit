-- 0138_phase_6_payments_and_inbound — Phase 7 schema (numbering
-- catches up to the actual phase count; the filename is fine).
--
--   1. patient_payments — Stripe PaymentIntent records for patient
--      responsibility balances + per-claim allocation.
--   2. inbound_webhooks — single inbox for inbound webhook
--      deliveries from third parties (Parachute, HSAT vendors,
--      future Stripe events that don't fit existing handlers).
--   3. documentation_packets — generated multi-doc PDF packets
--      (sleep study + Rx + compliance attestation + cover letter)
--      for fax/mail PA support.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. patient_payments — patient-facing payments + claim allocation
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."patient_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Stripe PaymentIntent id; null while we're in the pre-Stripe
  -- "intent created but Stripe hasn't returned" window.
  "stripe_payment_intent_id" varchar(80) UNIQUE,
  "amount_cents" bigint NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'usd',
  -- Lifecycle: 'pending' (intent created) → 'requires_action' (3DS) →
  -- 'succeeded' (Stripe confirmed) | 'failed' | 'cancelled' |
  -- 'refunded' (post-success reversal).
  "status" text NOT NULL DEFAULT 'pending',
  -- Per-claim allocation snapshot. Array of:
  --   { claim_id, amount_applied_cents }
  -- Set when the patient picks which claims to pay against. Frozen
  -- at PaymentIntent confirmation so a later balance change doesn't
  -- rewrite payment history.
  "applied_claims_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the payment originated. 'portal' = patient self-served via
  -- /api/me/payments. 'csr' = staff entered on behalf of patient.
  "source" text NOT NULL DEFAULT 'portal',
  -- Optional patient-supplied note (memo on a check, etc).
  "note" text,
  -- Free-form failure message when status = 'failed'.
  "failure_reason" text,
  "succeeded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_payments_amount_pos"
    CHECK ("amount_cents" > 0),
  CONSTRAINT "patient_payments_currency_format"
    CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "patient_payments_status_enum"
    CHECK ("status" IN (
      'pending', 'requires_action', 'succeeded',
      'failed', 'cancelled', 'refunded'
    )),
  CONSTRAINT "patient_payments_source_enum"
    CHECK ("source" IN ('portal', 'csr', 'mail_in_check', 'external'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_payments_patient_idx"
  ON "resupply"."patient_payments" ("patient_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_payments_status_idx"
  ON "resupply"."patient_payments" ("status", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. inbound_webhooks — single inbox for third-party deliveries
-- ────────────────────────────────────────────────────────────────────
--
-- Distinct from `webhook_deliveries` (outbound) and `clearinghouse_inbound_files`
-- (SFTP-delivered EDI). Inbound HTTP webhooks land here verbatim;
-- per-source dispatchers process them.
CREATE TABLE IF NOT EXISTS "resupply"."inbound_webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Source slug — 'parachute' | 'itamar_hsat' | 'stripe' | etc.
  -- Drives dispatcher routing.
  "source" varchar(40) NOT NULL,
  -- Free-form event-type as the source emits it. We don't enumerate
  -- because each source publishes a different vocabulary.
  "source_event_type" varchar(120),
  -- The HTTP body as we received it (jsonb so the inbox is queryable).
  "payload_json" jsonb NOT NULL,
  -- HTTP headers we cared about (signature, idempotency-key, etc).
  -- We do NOT persist every inbound header — only the ones the
  -- dispatcher uses for verification + dedupe.
  "verification_headers_json" jsonb,
  "signature_verified" boolean NOT NULL DEFAULT false,
  -- Idempotency: dedupe key the source provided (most webhooks
  -- include a delivery-id header). When the source doesn't, we
  -- fall back to a sha256 of the payload.
  "dedupe_key" varchar(160) NOT NULL,
  "status" text NOT NULL DEFAULT 'received',
  "processing_error" text,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  CONSTRAINT "inbound_webhooks_status_enum"
    CHECK ("status" IN (
      'received', 'processed', 'duplicate', 'processing_failed', 'rejected'
    ))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_webhooks_source_dedupe_uq"
  ON "resupply"."inbound_webhooks" ("source", "dedupe_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inbound_webhooks_pending_idx"
  ON "resupply"."inbound_webhooks" ("status", "received_at")
  WHERE "status" IN ('received', 'processing_failed');
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. documentation_packets — combined PDF support packets
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."documentation_packets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- What the packet is for — drives the cover-letter template.
  "kind" text NOT NULL,
  -- Snapshot of source documents at packet generation time:
  --   { sleep_study_ids: [...], prescription_ids: [...],
  --     compliance_attestation_inline: true, dwo_document_ids: [...] }
  "included_docs_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Object-storage key for the rendered combined PDF.
  "pdf_object_key" text,
  -- Page count of the combined PDF (sanity check on the receiver
  -- side — "we sent a 12-page packet, did you receive 12 pages?").
  "page_count" integer,
  -- Free-form CSR note.
  "notes" text,
  "generated_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "documentation_packets_kind_enum"
    CHECK ("kind" IN (
      'prior_auth_support',
      'appeal_support',
      'accreditation_audit',
      'medical_records_request'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "documentation_packets_patient_idx"
  ON "resupply"."documentation_packets" ("patient_id", "created_at" DESC);
