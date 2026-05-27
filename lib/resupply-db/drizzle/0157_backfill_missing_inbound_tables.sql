-- 0157_backfill_missing_inbound_tables — narrow backfill that creates
-- the two tables the in-process pg-boss worker polls every minute
-- (inbound_webhooks, inbound_referral_status_outbox) so the
-- `integrations.inbound.dispatch` and `inbound_referral.status_outbound`
-- jobs stop logging PGRST205 ("table not in schema cache") every
-- tick.
--
-- Why a dedicated backfill instead of journalling 0138 and 0148:
-- ----------------------------------------------------------------
-- 0138 and 0148 are part of the larger migration-drift gap
-- documented in docs/migration-drift-status-2026-05-13.md — 100+
-- on-disk SQL files between 0050 and 0156 are NOT in
-- `meta/_journal.json`, so the migrator has never applied them.
-- Many of those migrations reference tables / columns introduced
-- by intermediate gap migrations (0144's FK to inbound_referral_orders,
-- 0144's FK to patients/providers, etc.), so trying to replay 0138
-- and 0148 verbatim now would cascade-fail on the missing
-- dependencies. Reconciling that whole gap is the open
-- "Switch resupply schema deploys from push to versioned migrations"
-- task and is intentionally out of scope here.
--
-- This file creates JUST the two empty tables the failing jobs
-- query, with the same column shapes 0138 and 0148 declare so when
-- the broader gap reconciliation lands and replays 0138 + 0148,
-- their `CREATE TABLE IF NOT EXISTS` statements are no-ops and the
-- column types match what the worker code already expects. The two
-- FK references that 0148 declares against
-- resupply.inbound_referral_orders are deliberately omitted — that
-- table also doesn't exist yet, and adding a deferred constraint
-- now would block this backfill on the same missing-dep cascade.
-- A follow-up "add FK once inbound_referral_orders exists" step is
-- the natural shape for the gap-reconciliation task.

-- ────────────────────────────────────────────────────────────────────
-- 1. inbound_webhooks — single inbox for third-party deliveries.
--    Mirrors 0138 + 0139 (processing_attempts column).
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."inbound_webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" varchar(40) NOT NULL,
  "source_event_type" varchar(120),
  "payload_json" jsonb NOT NULL,
  "verification_headers_json" jsonb,
  "signature_verified" boolean NOT NULL DEFAULT false,
  "dedupe_key" varchar(160) NOT NULL,
  "status" text NOT NULL DEFAULT 'received',
  "processing_error" text,
  "processing_attempts" smallint NOT NULL DEFAULT 0,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  CONSTRAINT "inbound_webhooks_status_enum"
    CHECK ("status" IN (
      'received', 'processed', 'duplicate', 'processing_failed', 'rejected'
    )),
  CONSTRAINT "inbound_webhooks_processing_attempts_nonneg"
    CHECK ("processing_attempts" >= 0)
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
-- 2. inbound_referral_status_outbox — one row per lifecycle event
--    we need to ship back to the source that submitted the referral.
--    Mirrors 0148 minus the FK to resupply.inbound_referral_orders
--    (see header comment). The worker only ever SELECT/UPDATEs by
--    id, so the missing FK doesn't change correctness today.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."inbound_referral_status_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid NOT NULL,
  "target_kind" varchar(40) NOT NULL,
  "event_type" varchar(80) NOT NULL,
  "payload_json" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "attempt_count" smallint NOT NULL DEFAULT 0,
  "last_http_status" integer,
  "last_error" text,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at" timestamp with time zone,
  "max_retries" smallint NOT NULL DEFAULT 5,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_referral_status_outbox_status_enum"
    CHECK ("status" IN ('queued', 'delivered', 'failed', 'exhausted')),
  CONSTRAINT "inbound_referral_status_outbox_target_kind_enum"
    CHECK ("target_kind" IN ('parachute', 'ehr_fhir')),
  CONSTRAINT "inbound_referral_status_outbox_max_retries_range"
    CHECK ("max_retries" >= 0 AND "max_retries" <= 12)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inbound_referral_status_outbox_due_idx"
  ON "resupply"."inbound_referral_status_outbox" ("status", "next_attempt_at")
  WHERE "status" = 'queued';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "inbound_referral_status_outbox_referral_idx"
  ON "resupply"."inbound_referral_status_outbox"
  ("referral_id", "created_at" DESC);
