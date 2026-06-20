-- Migration 0055: BEFORE UPDATE triggers for shop_subscriptions, fulfillments,
-- and episodes — completing the set started in 0054. The shared
-- resupply.set_updated_at() trigger function already exists from 0054.

CREATE TRIGGER trg_shop_subscriptions_set_updated_at
  BEFORE UPDATE ON resupply.shop_subscriptions
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_fulfillments_set_updated_at
  BEFORE UPDATE ON resupply.fulfillments
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_episodes_set_updated_at
  BEFORE UPDATE ON resupply.episodes
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
