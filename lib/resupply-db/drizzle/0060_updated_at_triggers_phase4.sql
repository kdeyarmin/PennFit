-- Migration 0060: BEFORE UPDATE triggers for resupply_auth.password_credentials and
-- public.reminder_subscriptions (storefront schema), completing the
-- updatedAt trigger coverage started in migrations 0054-0056.
-- The shared trigger functions already exist: resupply.set_updated_at() and
-- auth.set_updated_at() (created in 0054 and 0059 respectively).
--
-- Also: CHECK constraint for insurance_leads.status missed in migration 0059.
--
-- All statements are idempotent so this file can be safely replayed on
-- databases that already have a previous content-hash recorded.

DROP TRIGGER IF EXISTS trg_auth_password_credentials_set_updated_at
  ON resupply_auth.password_credentials;
CREATE TRIGGER trg_auth_password_credentials_set_updated_at
  BEFORE UPDATE ON resupply_auth.password_credentials
  FOR EACH ROW EXECUTE FUNCTION auth.set_updated_at();

DROP TRIGGER IF EXISTS trg_reminder_subscriptions_set_updated_at
  ON public.reminder_subscriptions;
CREATE TRIGGER trg_reminder_subscriptions_set_updated_at
  BEFORE UPDATE ON public.reminder_subscriptions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insurance_leads_status_enum'
      AND conrelid = 'resupply.insurance_leads'::regclass
  ) THEN
    ALTER TABLE resupply.insurance_leads
      ADD CONSTRAINT insurance_leads_status_enum
      CHECK (status IN ('new','contacted','verified','closed'));
  END IF;
END
$$;
