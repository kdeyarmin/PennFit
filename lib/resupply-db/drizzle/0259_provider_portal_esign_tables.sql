-- Provider e-signature portal — completes the schema.
--
-- CONTEXT: migration 0253_provider_portal_esign.sql (already on main)
-- created a MINIMAL `provider_portal_accounts` table (id, auth_user_id,
-- provider_id, email_lower, timestamps + the uniqueness indexes). This
-- migration finishes the feature on top of it:
--
--   1. ALTER provider_portal_accounts — add the lifecycle/MFA columns
--      the portal needs (status, mfa_enrolled_at, last_login_at,
--      invited/disabled audit columns). Done as ADD COLUMN IF NOT
--      EXISTS so it is idempotent and forward-deploy-safe; the base
--      table from 0253 is NOT re-created (a CREATE TABLE IF NOT EXISTS
--      would silently skip and leave these columns missing).
--   2. CREATE the four remaining tables — provider_mfa_secrets,
--      provider_mfa_recovery_codes, provider_signature_requests,
--      provider_signature_events (the hash-chained ceremony log).
--   3. Seed the `provider.portal_enabled` feature flag (OFF).
--
-- auth_user_id stays a soft reference to resupply_auth.users(id) (no
-- cross-schema FK — the migration runner lacks REFERENCES privilege on
-- resupply_auth; uniqueness is enforced by the 0253 index). The app
-- enforces the relationship in auth-deps.ts / requireProvider.ts.
--
-- Design notes (signatures, audit posture) live in
-- docs/provider-portal-esignature.md. Signatures are TYPED-NAME + ESIGN
-- consent (no image). provider_signature_events is a feature-local,
-- hash-chained log — NOT the retired global audit_log (migration 0156).
--
-- Forward-deploy-safe: every statement is IF NOT EXISTS / guarded /
-- ON CONFLICT DO NOTHING. Journal posture matches 0050+ (not journaled).

-- ────────────────────────────────────────────────────────────────
-- 1. Complete provider_portal_accounts (base table from 0253).
-- ────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."provider_portal_accounts"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'invited',
  ADD COLUMN IF NOT EXISTS "mfa_enrolled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "invited_by_email" text,
  ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "disabled_by_email" text;
--> statement-breakpoint
-- status enum guard (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_portal_accounts_status_chk'
      AND conrelid = 'resupply.provider_portal_accounts'::regclass
  ) THEN
    ALTER TABLE "resupply"."provider_portal_accounts"
      ADD CONSTRAINT "provider_portal_accounts_status_chk"
      CHECK ("status" IN ('invited', 'active', 'disabled'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_portal_accounts_status_idx"
  ON "resupply"."provider_portal_accounts" ("status");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 2a. provider_mfa_secrets — TOTP enrollment, keyed by the portal
-- account. Mirrors resupply.admin_mfa_secrets (0084/0091) but scoped to
-- the provider population. One verified row per device.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."provider_mfa_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL
    REFERENCES "resupply"."provider_portal_accounts"("id") ON DELETE CASCADE,
  "secret_base32" text NOT NULL,
  "device_label" text,
  -- NULL until the provider proves possession with a valid code.
  "verified_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  -- Highest matched HOTP counter — replay defense across the 30s window.
  "last_used_counter" bigint,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_mfa_secrets_account_idx"
  ON "resupply"."provider_mfa_secrets" ("account_id");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 2b. provider_mfa_recovery_codes — single-use backup codes (SHA-256).
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."provider_mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL
    REFERENCES "resupply"."provider_portal_accounts"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "used_ip" inet,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_mfa_recovery_codes_hash_unique"
  ON "resupply"."provider_mfa_recovery_codes" ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_mfa_recovery_codes_account_idx"
  ON "resupply"."provider_mfa_recovery_codes" ("account_id");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 2c. provider_signature_requests — the envelope of "things this
-- provider must e-sign". Created by employees, pushed to the provider's
-- authenticated queue. Optionally references an existing signable
-- subject (Rx packet, prescription, claim, order, CMN/DWO, or a
-- free-form document) by type + id, with a name/label snapshot so the
-- queue + certificate render without re-joining live PHI tables.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."provider_signature_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_id" uuid NOT NULL
    REFERENCES "resupply"."providers"("id") ON DELETE CASCADE,
  -- Denormalized so the queue filter is a single indexed lookup even
  -- before a portal account exists (an employee can stage requests for
  -- a provider who hasn't been invited yet).
  "account_id" uuid
    REFERENCES "resupply"."provider_portal_accounts"("id") ON DELETE SET NULL,
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  -- What is being signed.
  "subject_type" text NOT NULL,
  -- Free-form id of the referenced subject (no FK — subject lives in
  -- one of several tables). May be NULL for an ad-hoc document.
  "subject_id" text,
  "title" text NOT NULL,
  -- Patient/order/HCPCS context shown in the queue + on the certificate.
  "patient_name_snapshot" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pending  → awaiting provider signature
  -- signed   → provider e-signed
  -- declined → provider declined to sign
  -- void     → withdrawn by an employee before signing
  -- expired  → past expires_at without signature
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp with time zone,
  -- Signature ceremony capture (ESIGN: typed name + explicit consent).
  "signed_at" timestamp with time zone,
  "signer_name" text,
  "signer_title" text,
  "signer_npi" varchar(10),
  "consent_esign" boolean NOT NULL DEFAULT false,
  "signature_statement" text,
  "signer_ip" inet,
  "signer_user_agent" text,
  "decline_reason" text,
  -- Post-signature employee fulfillment stamps.
  "ready_to_print_at" timestamp with time zone,
  "ready_to_print_by_email" text,
  "returned_signed_at" timestamp with time zone,
  "returned_signed_by_email" text,
  "attached_to_chart_at" timestamp with time zone,
  "attached_to_chart_by_email" text,
  "released_at" timestamp with time zone,
  "released_by_email" text,
  -- 'claim' (release the insurance claim for billing) or 'item'
  -- (release the prescription / order item for fulfillment).
  "release_kind" text,
  "release_note" text,
  "created_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "provider_signature_requests_subject_type_chk"
    CHECK ("subject_type" IN (
      'prescription', 'prescription_packet', 'order', 'claim',
      'cmn', 'dwo', 'swo', 'document'
    )),
  CONSTRAINT "provider_signature_requests_status_chk"
    CHECK ("status" IN ('pending', 'signed', 'declined', 'void', 'expired')),
  CONSTRAINT "provider_signature_requests_release_kind_chk"
    CHECK ("release_kind" IS NULL OR "release_kind" IN ('claim', 'item'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_requests_provider_status_idx"
  ON "resupply"."provider_signature_requests" ("provider_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_requests_account_status_idx"
  ON "resupply"."provider_signature_requests" ("account_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_requests_patient_idx"
  ON "resupply"."provider_signature_requests" ("patient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_requests_status_created_idx"
  ON "resupply"."provider_signature_requests" ("status", "created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 2d. provider_signature_events — append-only, hash-chained ceremony
-- log. One row per lifecycle event. `seq` is the per-request ordinal;
-- `event_hash` chains off `prev_hash` so a printed certificate shows an
-- unbroken chain for Medicare / insurer audit. Hashes are computed in
-- application code (lib/provider-portal/signature-events.ts).
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."provider_signature_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL
    REFERENCES "resupply"."provider_signature_requests"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "event_type" text NOT NULL,
  -- 'provider' | 'employee' | 'system'
  "actor_kind" text NOT NULL,
  "actor_account_id" uuid
    REFERENCES "resupply"."provider_portal_accounts"("id") ON DELETE SET NULL,
  "actor_email" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip" inet,
  "user_agent" text,
  "prev_hash" text NOT NULL,
  "event_hash" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "provider_signature_events_actor_kind_chk"
    CHECK ("actor_kind" IN ('provider', 'employee', 'system')),
  CONSTRAINT "provider_signature_events_event_type_chk"
    CHECK ("event_type" IN (
      'created', 'viewed', 'signed', 'declined', 'reminded', 'voided',
      'ready_to_print', 'returned_signed', 'attached_to_chart', 'released'
    ))
);
--> statement-breakpoint
-- One row per (request, seq) — the ordinal is allocated in app code.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_signature_events_request_seq_unique"
  ON "resupply"."provider_signature_events" ("request_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_events_request_idx"
  ON "resupply"."provider_signature_events" ("request_id", "occurred_at");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- 3. Feature flag — the portal is OFF by default.
-- ────────────────────────────────────────────────────────────────
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('provider.portal_enabled',
   false,
   'Secure provider e-signature portal: physicians/NPs sign in (MFA-protected) to e-sign outstanding orders/prescriptions/claims; employees track + release signed items and print the signature audit log.',
   'Provider Portal')
ON CONFLICT (key) DO NOTHING;
