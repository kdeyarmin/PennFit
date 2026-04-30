-- Adds idempotency columns for the two transactional shop emails:
-- order confirmation (sent from the Stripe webhook on
-- checkout.session.completed) and shipping notification (sent from
-- the admin "enter tracking" endpoint).
--
-- Why TWO separate columns rather than one "last_email_sent_at":
--   The two emails fire from completely different triggers and at
--   different points in the order lifecycle. Collapsing them onto
--   one column would force a rule like "we already sent SOMETHING,
--   skip the next thing too" which is wrong — every paid order
--   should get a confirmation AND a shipping notification, the
--   second one when shipped_at gets stamped. They're independent
--   gates.
--
-- Why NULLABLE additive (no default, no backfill):
--   * Pre-existing paid orders had no confirmation email either way;
--     leaving them NULL means "no email recorded for this order"
--     which is the truthful state. We deliberately do NOT retro-send
--     to historical orders — surprise-emailing customers about an
--     order they bought weeks ago would erode trust.
--   * shipping_email_sent_at NULL on already-shipped historical orders
--     also means "no email recorded"; the admin endpoint that wires
--     the shipping email runs only on NEW tracking entries, so the
--     historical-NULL state is not retroactively sent either.
--
-- Why no index:
--   * Both columns are read together with the row itself (the
--     webhook fetches the order by id, the admin route already
--     fetched the row). Neither powers a list query.
--
-- Per ADR 003 — versioned hand-authored migration; this codebase
-- does not use db:push because db:push silently rewrites columns
-- once PHI lands.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "confirmation_email_sent_at" timestamp with time zone;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "shipping_email_sent_at" timestamp with time zone;
