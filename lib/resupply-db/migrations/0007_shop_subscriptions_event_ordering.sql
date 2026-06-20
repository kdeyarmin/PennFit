-- Webhook ordering protection for shop_subscriptions.
--
-- Adds last_stripe_event_at so customer.subscription.* upserts in
-- webhook-handler.ts can refuse to overwrite newer state with a
-- replayed/late event. Nullable + no default — legacy rows written
-- before this column existed treat the first new event as winning.
-- Pure additive change; no data backfill or rewrite.
ALTER TABLE "resupply"."shop_subscriptions"
  ADD COLUMN "last_stripe_event_at" timestamp with time zone;
