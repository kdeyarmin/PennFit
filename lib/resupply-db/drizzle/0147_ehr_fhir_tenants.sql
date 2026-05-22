-- 0147_ehr_fhir_tenants — Phase 4 of the inbound referral roadmap.
--
-- Adds:
--   ehr_fhir_tenants — one row per EHR partner (Athena, Epic,
--   PointClickCare, etc.) that POSTs SMART-on-FHIR ServiceRequest
--   bundles into /fhir/r4/ServiceRequest. Per-tenant rows let us
--   onboard new partners without code changes:
--
--     1. Add a row with the partner's JWKS URI + audience
--     2. The middleware (requireSmartFhirAccess) verifies inbound
--        JWTs against that JWKS
--     3. Successful POSTs land in inbound_webhooks with
--        source = ehr_fhir_<slug> and reuse the Phase 1+2
--        dispatcher pipeline (matchers, classifier, triage queue)
--
-- Why a separate table (vs. reusing payer_profiles or providers):
-- Tenants are a third axis — neither payer nor provider — and a
-- single tenant may submit orders for many payers and many
-- providers. The relationship is many-to-many at the partner level
-- but the auth gate is one-per-row.
--
-- PHI posture: tenant rows hold partner metadata only (JWKS URI,
-- public audience string, display name). No PHI lives here.
--
-- Per ADR 003 — versioned hand-authored migration. New table; safe
-- to re-apply via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "resupply"."ehr_fhir_tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- URL-safe partner identifier. Used as the source slug — incoming
  -- ServiceRequest POSTs land in inbound_webhooks with
  -- source = 'ehr_fhir_<slug>'. Match [a-z0-9_]{2,38} so the
  -- combined slug stays under inbound_webhooks.source's 40-char cap.
  "slug" varchar(38) NOT NULL UNIQUE,
  "display_name" varchar(160) NOT NULL,
  -- The partner's JWKS endpoint. We fetch it on demand (with a
  -- short in-memory cache in the verifier) — never proxy through it,
  -- never cache long-term. EHR JWKS rotation is rare but real.
  "jwks_uri" text NOT NULL,
  -- The `aud` claim value we expect on inbound JWTs. Always our own
  -- token endpoint URL per SMART-on-FHIR Backend Services spec.
  -- Storing per-tenant lets us migrate the audience without coupling
  -- to a single env var.
  "audience" text NOT NULL,
  -- The `iss` and `sub` claim values we expect — for backend services
  -- both are the partner's client_id. We don't enforce client_id
  -- pattern (Athena / Epic shape these differently) but we do enforce
  -- exact-match against expected_issuer + expected_subject.
  "expected_issuer" text NOT NULL,
  "expected_subject" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ehr_fhir_tenants_slug_format"
    CHECK ("slug" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ehr_fhir_tenants_active_idx"
  ON "resupply"."ehr_fhir_tenants" ("is_active", "slug")
  WHERE "is_active" = true;
