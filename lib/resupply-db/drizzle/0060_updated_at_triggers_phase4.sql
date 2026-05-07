-- Migration 0060: BEFORE UPDATE triggers for auth.password_credentials and
-- resupply.reminder_subscriptions (storefront schema), completing the
-- updatedAt trigger coverage started in migrations 0054-0056.
-- The shared trigger functions already exist: resupply.set_updated_at() and
-- auth.set_updated_at() (created in 0054 and 0059 respectively).
--
-- Also: CHECK constraint for insurance_leads.status missed in migration 0059.

CREATE TRIGGER trg_auth_password_credentials_set_updated_at
  BEFORE UPDATE ON auth.password_credentials
  FOR EACH ROW EXECUTE FUNCTION auth.set_updated_at();

CREATE TRIGGER trg_reminder_subscriptions_set_updated_at
  BEFORE UPDATE ON resupply.reminder_subscriptions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

ALTER TABLE resupply.insurance_leads
  ADD CONSTRAINT insurance_leads_status_enum
  CHECK (status IN ('new','contacted','verified','closed'));
