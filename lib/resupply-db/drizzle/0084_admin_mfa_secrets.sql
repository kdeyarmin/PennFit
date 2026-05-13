-- admin_mfa_secrets — TOTP shared secrets for admin/CSR accounts.
-- See lib/resupply-db/src/schema/admin-mfa-secrets.ts for the full
-- rationale, Phase A (enrollment-only) posture, and replay-
-- prevention semantics via last_used_counter.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."admin_mfa_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_user_id" uuid NOT NULL REFERENCES "resupply"."admin_users"("id") ON DELETE CASCADE,
  "secret_base32" text NOT NULL,
  "verified_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "last_used_counter" bigint,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- One MFA secret per admin — the unique constraint is what the
-- "Begin enroll" endpoint relies on for overwrite-if-unverified
-- upsert semantics. We deliberately keep one row per admin rather
-- than allowing multiple enrolled devices in this sprint; a Phase
-- B that adds multi-device support can drop this unique and add
-- a device_label column.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_mfa_secrets_staff_user_unique"
  ON "resupply"."admin_mfa_secrets" ("staff_user_id");

CREATE INDEX IF NOT EXISTS "admin_mfa_secrets_verified_at_idx"
  ON "resupply"."admin_mfa_secrets" ("verified_at");
