-- Migration 0059: DB-level CHECK constraints on status/role columns for
-- admin_users and resupply_auth.users. The shared trigger function from 0054 also
-- covers resupply_auth.users updatedAt (trigger added below).
-- patient_onboarding_journeys and shop_product_questions already have their
-- status CHECKs from earlier migrations; this migration only adds new ones.

ALTER TABLE resupply.admin_users
  ADD CONSTRAINT admin_users_status_enum
  CHECK (status IN ('pending','active','revoked'));

ALTER TABLE resupply.admin_users
  ADD CONSTRAINT admin_users_role_enum
  CHECK (role IN ('admin','agent'));

ALTER TABLE resupply_auth.users
  ADD CONSTRAINT auth_users_status_enum
  CHECK (status IN ('active','invited','locked','revoked'));

ALTER TABLE resupply_auth.users
  ADD CONSTRAINT auth_users_role_enum
  CHECK (role IN ('customer','agent','admin'));

-- updatedAt trigger for resupply_auth.users (missed in migrations 0054-0056
-- which only covered the resupply schema).
CREATE OR REPLACE FUNCTION auth.set_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_auth_users_set_updated_at
  BEFORE UPDATE ON resupply_auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.set_updated_at();
