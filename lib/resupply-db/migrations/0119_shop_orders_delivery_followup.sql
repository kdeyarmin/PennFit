-- 0119_shop_orders_delivery_followup — track the "how did it go?"
-- post-delivery checkin email.
--
-- Why
-- ---
-- The shipping notification already fires when an admin enters
-- tracking (sendShippingNotificationIfNew). Nothing fires AFTER the
-- parcel arrives. That post-delivery touchpoint — "how did it go?
-- was the fit right? text us if anything's off" — is the single
-- highest-ROI satisfaction signal a DME supplier has access to, and
-- it also creates a clean intake for early returns / RMAs before
-- the patient gives up and stops responding.
--
-- The new worker job (shop-order.delivery-followup) scans paid
-- orders whose `delivered_at` is 3–14 days ago and whose
-- `delivery_followup_sent_at` is NULL, then sends one email per
-- order. Like the shipping-email column, this is an atomic-claim
-- target: the worker stamps the timestamp BEFORE the send so a
-- crashing send can't double-deliver.
--
-- Why 3 days
-- ----------
-- New CPAP supplies (mask, hose) need a couple of nights to break
-- in before the patient can answer "did it fit?". 3 days is the
-- industry-standard sweet spot — earlier feels intrusive, later
-- has worse open rates because the patient has moved on.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "delivery_followup_sent_at"
  timestamp with time zone;
--> statement-breakpoint

-- Hot query for the dispatcher: rows that delivered between 3 and
-- 14 days ago and haven't been emailed yet. A partial index keeps
-- it tiny — once a row is stamped it falls out of the index.
CREATE INDEX IF NOT EXISTS "shop_orders_delivery_followup_due_idx"
  ON "resupply"."shop_orders" ("delivered_at" DESC)
  WHERE "delivered_at" IS NOT NULL
    AND "delivery_followup_sent_at" IS NULL;
