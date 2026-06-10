-- 0253_provider_portal_esign — provider portal accounts and e-sign support.
--
-- Adds the provider_portal_accounts table so a prescriber can claim a
-- persistent portal account (rather than using a one-time token link)
-- and sign documents electronically through the portal.
--
-- auth_user_id note
-- -----------------
-- This column references resupply_auth.users(id) at the application
-- level (enforced in auth-deps.ts and requireProvider.ts). A database-
-- level REFERENCES clause across schemas requires the migration runner
-- to hold REFERENCES privilege on resupply_auth.users, which it does
-- not. The one-account-per-auth-user invariant is enforced instead by
-- the unique index below. No cross-schema FK is declared here.
--
-- Per ADR 003 — versioned hand-authored migration. Plain table, no RLS;
-- service-role client only.

CREATE TABLE IF NOT EXISTS "resupply"."provider_portal_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Soft reference to resupply_auth.users(id). Uniqueness is enforced
  -- by the index below. Relationship is enforced in application code,
  -- not at the database level (see note above).
  "auth_user_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL
    REFERENCES "resupply"."providers"("id") ON DELETE CASCADE,
  "email_lower" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One portal account per auth user — enforces the uniqueness invariant
-- that would otherwise be expressed as a FK + UNIQUE on auth_user_id.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_portal_accounts_auth_user_id_uq"
  ON "resupply"."provider_portal_accounts" ("auth_user_id");
--> statement-breakpoint

-- Provider → its portal account (used by the admin UI to show whether
-- a provider has claimed their portal).
CREATE UNIQUE INDEX IF NOT EXISTS "provider_portal_accounts_provider_id_uq"
  ON "resupply"."provider_portal_accounts" ("provider_id");
--> statement-breakpoint

-- Email lookup for sign-in.
CREATE INDEX IF NOT EXISTS "provider_portal_accounts_email_idx"
  ON "resupply"."provider_portal_accounts" ("email_lower");
