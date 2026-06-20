-- 0148_inbound_referral_status_outbox — Phase 5 of the inbound
-- referral roadmap.
--
-- Adds:
--   1. inbound_referral_status_outbox — one row per lifecycle event
--      we need to ship back to the source that submitted the
--      referral. A worker drains this table, HMAC-signs the body,
--      and POSTs to the resolved per-source callback URL with
--      exponential-backoff retries.
--   2. ehr_fhir_tenants.callback_url + .outbound_signing_secret —
--      per-tenant outbound config so EHRs that consume our status
--      callbacks can opt in independently of inbound config. Null
--      values mean "we accept inbound from this partner but don't
--      send callbacks back" (e.g. read-only EHR integrations).
--
-- Why a dedicated outbox (vs. reusing webhook_deliveries):
-- ----------------------------------------------------
-- webhook_deliveries (migration 0137) is keyed off
-- webhook_subscriptions — one explicit row per customer-side
-- subscriber URL. The referral-status case has no "subscriber" row:
-- the destination is fully determined by the referral's source slug
-- (env-based config for Parachute, per-tenant DB row for
-- ehr_fhir_<slug>). Forcing referral status into the subscriber
-- model would create one subscription per EHR tenant + a special
-- one for Parachute, all of which would shadow the existing surface
-- without adding clarity. A dedicated outbox keeps the worker tight
-- and the audit story per-referral.
--
-- Why store target_kind + denormalised resolved fields:
-- ----------------------------------------------------
-- The dispatcher resolves callback URL + signing secret at *dispatch
-- time* (not enqueue time), so secret rotation between enqueue and
-- dispatch is honored. We persist target_kind on the row so the
-- worker doesn't have to JOIN through inbound_referral_orders +
-- ehr_fhir_tenants to pick the right resolver.
--
-- Per ADR 003 — versioned hand-authored migration. Forward-deploy-
-- safe via IF NOT EXISTS.

-- ────────────────────────────────────────────────────────────────────
-- 1. inbound_referral_status_outbox
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."inbound_referral_status_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE,
  -- 'parachute' | 'ehr_fhir'. Drives the per-target resolver in the
  -- worker. Persisted (not derived) so the worker is a single SELECT
  -- + a CASE rather than a JOIN cascade.
  "target_kind" varchar(40) NOT NULL,
  -- Lifecycle event types — free-form, but the dispatcher knows the
  -- emitted shape of each:
  --   order.accepted           — CSR accepted via /accept route
  --   order.rejected           — CSR rejected
  --   prior_auth.decision      — DaVinci PAS or fax-PA returned a decision
  --   shop_order.shipped       — fulfillment shipped
  --   shop_order.delivered     — carrier confirmed delivery
  "event_type" varchar(80) NOT NULL,
  -- The exact JSON body we'll POST. Built at enqueue time and
  -- frozen — re-serialising at dispatch would change whitespace
  -- and break the HMAC the partner verifies.
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

-- The worker's drain query.
CREATE INDEX IF NOT EXISTS "inbound_referral_status_outbox_due_idx"
  ON "resupply"."inbound_referral_status_outbox" ("status", "next_attempt_at")
  WHERE "status" = 'queued';
--> statement-breakpoint

-- The detail-page timeline ribbon.
CREATE INDEX IF NOT EXISTS "inbound_referral_status_outbox_referral_idx"
  ON "resupply"."inbound_referral_status_outbox"
  ("referral_id", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. ehr_fhir_tenants — outbound config
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."ehr_fhir_tenants"
  ADD COLUMN IF NOT EXISTS "callback_url" text;
--> statement-breakpoint

-- Per-tenant HMAC secret for OUTBOUND callbacks. Distinct from the
-- inbound JWT verification — inbound uses the tenant's JWKS (their
-- public key), outbound uses a shared secret WE control + ship to
-- the tenant once at onboarding.
ALTER TABLE "resupply"."ehr_fhir_tenants"
  ADD COLUMN IF NOT EXISTS "outbound_signing_secret" text;
