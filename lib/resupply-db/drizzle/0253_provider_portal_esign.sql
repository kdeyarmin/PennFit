-- Provider e-signature portal (Task: provider-portal-esignature).
--
-- A secure, MFA-protected portal where ordering physicians / NPs sign
-- in and e-sign the orders, prescriptions, CMNs/DWOs, and claims that
-- are outstanding for THEIR patients. Once a provider signs, employees
-- mark the item ready-to-print, note it returned-signed + attached to
-- the patient chart, and release the claim / item. A printable,
-- tamper-evident signature log (per request or per provider) can be
-- generated for Medicare / insurer audit.
--
-- Design notes
-- ------------
--   * Provider login REUSES the in-house auth stack. A provider is a
--     normal `resupply_auth.users` row (role 'customer' — the lowest
--     privilege, so a provider can NEVER pass requireAdmin) that is
--     LINKED to a `resupply.providers` row via
--     `provider_portal_accounts`. "Provider-ness" is the existence of
--     that link, not an auth role — this keeps the staff RBAC gate and
--     the role CHECK constraint untouched.
--   * MFA reuses the same TOTP + recovery-code primitives as admin MFA,
--     but in provider-scoped tables keyed by the portal account so the
--     two populations never share a secret row.
--   * Signatures are TYPED-NAME + explicit ESIGN consent (no drawn
--     image), which satisfies the ESIGN Act / Medicare e-signature
--     guidance and sidesteps the repo's "no image logging" rule.
--   * `provider_signature_events` is a feature-local, hash-chained
--     append-only log for THIS portal's signature ceremony. It is NOT
--     the retired global `resupply.audit_log` machinery (migration
--     0156) and adds no readers against that table — the hash chain is
--     scoped to producing a single printable signature certificate.
--
-- Forward-deploy-safe: every statement is IF NOT EXISTS / ON CONFLICT
-- DO NOTHING. Journal posture matches 0050+ (not journaled).

-- ────────────────────────────────────────────────────────────────
-- provider_portal_accounts — links an auth user to a provider record.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."provider_portal_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The in-house auth user the provider signs in as. Cross-schema FK
  -- into resupply_auth.users; ON DELETE CASCADE so removing the auth
  -- user tears down the portal link.
  "auth_user_id" uuid NOT NULL
    REFERENCES "resupply_auth"."users"("id") ON DELETE CASCADE,
  -- The clinical provider this account acts for.
  "provider_id" uuid NOT NULL
    REFERENCES "resupply"."providers"("id") ON DELETE CASCADE,
  "email_lower" text NOT NULL,
  -- invited  → account created, password-set / verify email sent
  -- active   → provider has signed in at least once
  -- disabled → access revoked by an employee (kept for audit)
  "status" text NOT NULL DEFAULT 'invited',
  "mfa_enrolled_at" timestamp with time zone,
  "last_login_at" timestamp with time zone,
  "invited_by_email" text,
  "disabled_at" timestamp with time zone,
  "disabled_by_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "provider_portal_accounts_status_chk"
    CHECK ("status" IN ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
-- One portal account per auth user, and one per provider record.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_portal_accounts_auth_user_unique"
  ON "resupply"."provider_portal_accounts" ("auth_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_portal_accounts_provider_unique"
  ON "resupply"."provider_portal_accounts" ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_portal_accounts_status_idx"
  ON "resupply"."provider_portal_accounts" ("status");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────
-- provider_mfa_secrets — TOTP enrollment, keyed by the portal account.
-- Mirrors resupply.admin_mfa_secrets (migration 0084/0091) but scoped
-- to the provider population. One verified row per device.
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
-- provider_mfa_recovery_codes — single-use backup codes (SHA-256).
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
-- provider_signature_requests — the envelope of "things this provider
-- must e-sign". Created by employees, pushed to the provider's
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
-- provider_signature_events — append-only, hash-chained ceremony log.
-- One row per lifecycle event (created / viewed / signed / declined /
-- reminded / voided / ready_to_print / returned_signed / attached /
-- released). `seq` is the per-request ordinal; `event_hash` chains off
-- `prev_hash` so a printed certificate can show an unbroken chain for
-- Medicare / insurer audit. Hashes are computed in application code
-- (see lib/provider-portal/signature-events.ts).
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
-- Feature flag — the portal is OFF by default. Flipping it on enables
-- the provider sign-in surface + the employee management console.
-- ────────────────────────────────────────────────────────────────
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('provider.portal_enabled',
   false,
   'Secure provider e-signature portal: physicians/NPs sign in (MFA-protected) to e-sign outstanding orders/prescriptions/claims; employees track + release signed items and print the signature audit log.',
   'Provider Portal')
ON CONFLICT (key) DO NOTHING;
