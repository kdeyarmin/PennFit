-- Migration 0056: BEFORE UPDATE triggers for the remaining 16 tables that
-- have an updated_at column but no trigger. The shared
-- resupply.set_updated_at() function was created in migration 0054.

CREATE TRIGGER trg_admin_users_set_updated_at
  BEFORE UPDATE ON resupply.admin_users
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_frequency_rules_set_updated_at
  BEFORE UPDATE ON resupply.frequency_rules
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_insurance_leads_set_updated_at
  BEFORE UPDATE ON resupply.insurance_leads
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_patient_documents_set_updated_at
  BEFORE UPDATE ON resupply.patient_documents
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_patient_latest_message_set_updated_at
  BEFORE UPDATE ON resupply.patient_latest_message
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_patient_onboarding_journeys_set_updated_at
  BEFORE UPDATE ON resupply.patient_onboarding_journeys
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_patient_smart_trigger_events_set_updated_at
  BEFORE UPDATE ON resupply.patient_smart_trigger_events
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_patient_therapy_nights_set_updated_at
  BEFORE UPDATE ON resupply.patient_therapy_nights
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_physician_fax_outreach_set_updated_at
  BEFORE UPDATE ON resupply.physician_fax_outreach
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_prescriptions_set_updated_at
  BEFORE UPDATE ON resupply.prescriptions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_abandoned_carts_set_updated_at
  BEFORE UPDATE ON resupply.shop_abandoned_carts
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_customer_push_subscriptions_set_updated_at
  BEFORE UPDATE ON resupply.shop_customer_push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_product_compatibility_set_updated_at
  BEFORE UPDATE ON resupply.shop_product_compatibility
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_product_questions_set_updated_at
  BEFORE UPDATE ON resupply.shop_product_questions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_returns_set_updated_at
  BEFORE UPDATE ON resupply.shop_returns
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_reviews_set_updated_at
  BEFORE UPDATE ON resupply.shop_reviews
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
