-- 0137_phase_5_workflow_automation — Phase 5 schema for the
-- operational workflow + integration enabler bundle:
--
--   1. webhook_subscriptions + webhook_deliveries — outbound
--      event publishing so external systems (CRM, accounting,
--      reporting BI) can subscribe to billing events without
--      polling our API.
--   2. patient_billing_statements — audit trail of patient-facing
--      statements rendered for unpaid balances.
--   3. claim_appeal_letters — audit trail of appeal-letter PDFs
--      generated from the AI denial analyzer's sketches.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. webhook_subscriptions — outbound event subscribers.
-- ────────────────────────────────────────────────────────────────────
--
-- Each row is one HTTP endpoint that wants to receive specific event
-- types from our system. The dispatcher worker reads new
-- webhook_deliveries rows, POSTs them with an HMAC-SHA256 signature
-- header (X-PennFit-Signature = base64-hmac(secret, body)), and
-- retries with exponential backoff on 5xx / network failures.
CREATE TABLE IF NOT EXISTS "resupply"."webhook_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(160) NOT NULL,
  -- Destination URL (HTTPS only enforced by the dispatcher).
  "target_url" text NOT NULL,
  -- 32+ random bytes; the dispatcher HMACs the body with this and
  -- adds X-PennFit-Signature so the subscriber can verify the call
  -- came from us. Treat as a secret.
  "signing_secret" text NOT NULL,
  -- Array of event-type strings this subscriber wants. Star expands
  -- to "all events". Examples: 'claim.paid', 'claim.denied',
  -- 'era.ingested', 'capped_rental.month_rolled', 'pa.approved'.
  "event_types" text[] NOT NULL DEFAULT '{*}',
  "is_active" boolean NOT NULL DEFAULT true,
  -- Per-subscriber max retry attempts; defaults to 5. After failing
  -- this many times the delivery is parked in status='exhausted'.
  "max_retries" smallint NOT NULL DEFAULT 5,
  "last_delivery_at" timestamp with time zone,
  "last_delivery_status" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_subscriptions_max_retries_range"
    CHECK ("max_retries" >= 0 AND "max_retries" <= 12),
  CONSTRAINT "webhook_subscriptions_last_status_enum"
    CHECK (
      "last_delivery_status" IS NULL
      OR "last_delivery_status" IN (
        'delivered', 'failed', 'exhausted'
      )
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_active_idx"
  ON "resupply"."webhook_subscriptions" ("is_active")
  WHERE "is_active" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. webhook_deliveries — per-event-per-subscriber attempt log.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL
    REFERENCES "resupply"."webhook_subscriptions"("id") ON DELETE CASCADE,
  "event_type" varchar(80) NOT NULL,
  -- The event payload as it was sent (jsonb so the audit reads).
  "event_payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "attempt_count" smallint NOT NULL DEFAULT 0,
  -- HTTP status from the most recent attempt; null on transport failure.
  "last_http_status" integer,
  -- Caller-safe failure message on the most recent attempt.
  "last_error" text,
  -- When the dispatcher will next pick this row up (exponential backoff).
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_deliveries_status_enum"
    CHECK ("status" IN ('queued', 'delivered', 'failed', 'exhausted'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx"
  ON "resupply"."webhook_deliveries" ("status", "next_attempt_at")
  WHERE "status" = 'queued';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscription_idx"
  ON "resupply"."webhook_deliveries" ("subscription_id", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. patient_billing_statements — patient-facing balance statements.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."patient_billing_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Snapshot of the unpaid claim rows included in this statement.
  -- Each entry:
  --   { claim_id, payer_name, date_of_service, billed_cents,
  --     paid_cents, patient_responsibility_cents }
  "line_items_json" jsonb NOT NULL,
  "total_patient_responsibility_cents" bigint NOT NULL DEFAULT 0,
  "statement_pdf_object_key" text,
  "delivery_method" text,
  "delivered_at" timestamp with time zone,
  "generated_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_billing_statements_total_nonneg"
    CHECK ("total_patient_responsibility_cents" >= 0),
  CONSTRAINT "patient_billing_statements_delivery_method_enum"
    CHECK (
      "delivery_method" IS NULL
      OR "delivery_method" IN ('email', 'sms', 'mail', 'in_person')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_billing_statements_patient_idx"
  ON "resupply"."patient_billing_statements"
  ("patient_id", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. claim_appeal_letters — audit trail of generated appeal PDFs.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."claim_appeal_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  -- Pointer to the denial analysis that informed this letter; null
  -- when the CSR drafted manually without the AI assist.
  "denial_analysis_id" uuid
    REFERENCES "resupply"."claim_denial_analyses"("id") ON DELETE SET NULL,
  "letter_body" text NOT NULL,
  "appeal_pdf_object_key" text,
  -- Delivery channel chosen by the CSR. The actual send is a separate
  -- audit row (logAudit action='claim_appeal.send').
  "delivery_method" text,
  "delivered_at" timestamp with time zone,
  "generated_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "claim_appeal_letters_delivery_method_enum"
    CHECK (
      "delivery_method" IS NULL
      OR "delivery_method" IN ('fax', 'mail', 'portal_upload', 'email')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "claim_appeal_letters_claim_idx"
  ON "resupply"."claim_appeal_letters" ("claim_id", "created_at" DESC);
