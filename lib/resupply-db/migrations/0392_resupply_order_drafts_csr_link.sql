-- 0392_resupply_order_drafts_csr_link — link an approved draft to the CSR
-- sign-&-pay order request it produced.
--
-- Approving a resupply draft creates a `csr_order_requests` row (the
-- sign-&-pay flow) and emails/texts the patient a Stripe Hosted Checkout
-- link. The concrete `shop_orders` row only materialises when the patient
-- pays (the Stripe webhook), so at approve time the artifact is the order
-- REQUEST — record its id here. `shop_order_id` (migration 0391) is
-- backfilled later when payment lands.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."resupply_order_drafts"
  ADD COLUMN IF NOT EXISTS "csr_order_request_id" uuid;
