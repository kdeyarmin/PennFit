-- 0320_counter_orders — Front Desk walk-in / counter ordering.
--
-- Adds the columns the CSR "Front Desk" counter-order endpoint
-- (POST /admin/shop/counter-orders) needs to record an order rung up
-- in person, plus the Control Center feature flag that gates the whole
-- surface.
--
-- Why these columns:
--   * source            — distinguishes a storefront (Stripe Hosted
--                         Checkout) order from one a CSR rang up at the
--                         DME counter. Lets analytics / fulfillment
--                         filter the two channels apart. Existing rows
--                         and the storefront default to 'storefront'.
--   * payment_method    — how the in-person order was paid. 'stripe' is
--                         the implicit value for every storefront order
--                         (left NULL on those; only counter orders set
--                         it). Counter orders set 'cash' (collected at
--                         the counter → status 'paid' immediately) or
--                         'insurance' (no money collected → status
--                         'pending', flagged for the billing worklist).
--   * counter_csr_email — operational attribution: which staff member
--                         rang up the counter order. NOT PHI (it is a
--                         staff email, same surface already stored in
--                         audit rows as admin_email).
--
-- All three are nullable with no backfill so this is a pure additive,
-- idempotent change — existing storefront orders are untouched.
--
-- Also makes shop_order_items.paid_at NULLABLE. It used to be NOT NULL
-- because the storefront only ever inserts line items at paid-time (the
-- Stripe webhook), so a line item implied a paid sale — and revenue /
-- margin analytics filter on `paid_at` as a proxy for "paid revenue". A
-- counter insurance order, though, is dispensed now but is NOT paid until
-- the payer adjudicates, so its line items must be recorded (for the
-- dispensing / COGS record) WITHOUT counting as paid revenue. We model
-- "not paid yet" as paid_at = NULL: every existing `paid_at`-filtered
-- analytics query then excludes those lines automatically, and paid_at is
-- stamped when the claim is actually paid. Idempotent (DROP NOT NULL is a
-- no-op when the column is already nullable).
--
-- Keep the flag key in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

ALTER TABLE resupply.shop_orders
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'storefront';
--> statement-breakpoint
ALTER TABLE resupply.shop_orders
  ADD COLUMN IF NOT EXISTS payment_method text;
--> statement-breakpoint
ALTER TABLE resupply.shop_orders
  ADD COLUMN IF NOT EXISTS counter_csr_email text;
--> statement-breakpoint
ALTER TABLE resupply.shop_order_items
  ALTER COLUMN paid_at DROP NOT NULL;
--> statement-breakpoint
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('frontdesk.counter_orders',
   true,
   'Front Desk walk-in ordering. When ON, CSRs can capture a walk-in customer and ring up a counter order (cash or bill-to-insurance) from the Front Desk page. When OFF, the counter-order endpoint returns 503 and the Front Desk order panel is disabled; existing orders are unaffected.',
   'Operations')
ON CONFLICT (key) DO NOTHING;
