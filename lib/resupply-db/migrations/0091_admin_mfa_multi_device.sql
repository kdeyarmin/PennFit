-- admin_mfa_secrets — relax (staff_user_id) UNIQUE to support
-- multi-device enrollment. See schema/admin-mfa-secrets.ts for the
-- new device_label column rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

BEGIN;

-- Drop the single-secret-per-admin UNIQUE. The hot-path read is
-- still by staff_user_id, so replace it with a plain index.
DROP INDEX IF EXISTS "resupply"."admin_mfa_secrets_staff_user_unique";

CREATE INDEX IF NOT EXISTS "admin_mfa_secrets_staff_user_idx"
  ON "resupply"."admin_mfa_secrets" ("staff_user_id");

ALTER TABLE "resupply"."admin_mfa_secrets"
  ADD COLUMN IF NOT EXISTS "device_label" varchar(64);

COMMIT;
