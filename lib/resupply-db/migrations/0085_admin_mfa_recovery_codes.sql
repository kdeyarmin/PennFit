-- admin_mfa_recovery_codes — single-use backup codes for admin MFA.
-- See lib/resupply-db/src/schema/admin-mfa-recovery-codes.ts for the
-- full rationale (shown-once posture, SHA-256 hashing, why we keep
-- used rows for audit, deferred regenerate flow).
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."admin_mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "staff_user_id" text NOT NULL REFERENCES "resupply"."admin_users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "used_ip" inet,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "admin_mfa_recovery_codes_staff_user_idx"
  ON "resupply"."admin_mfa_recovery_codes" ("staff_user_id");

-- Code hashes are globally unique by construction; the unique
-- constraint also lets sign-in look up by hash directly without
-- scanning the staff user's batch.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_mfa_recovery_codes_code_hash_unique"
  ON "resupply"."admin_mfa_recovery_codes" ("code_hash");
