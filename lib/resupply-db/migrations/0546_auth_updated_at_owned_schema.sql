-- Historical migrations 0059/0060 placed this application helper in the
-- managed Supabase auth schema. New replays adapt those statements; existing
-- databases converge here without changing or dropping managed auth objects.
CREATE OR REPLACE FUNCTION resupply_auth.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auth_users_set_updated_at ON resupply_auth.users;
CREATE TRIGGER trg_auth_users_set_updated_at
  BEFORE UPDATE ON resupply_auth.users
  FOR EACH ROW EXECUTE FUNCTION resupply_auth.set_updated_at();

DROP TRIGGER IF EXISTS trg_auth_password_credentials_set_updated_at
  ON resupply_auth.password_credentials;
CREATE TRIGGER trg_auth_password_credentials_set_updated_at
  BEFORE UPDATE ON resupply_auth.password_credentials
  FOR EACH ROW EXECUTE FUNCTION resupply_auth.set_updated_at();

REVOKE EXECUTE ON FUNCTION resupply_auth.set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply_auth.set_updated_at() TO service_role;
