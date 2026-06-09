-- 0245_shop_customers_phone_and_voice_session_id_type
--
-- Two related changes that unblock resolving an inbound caller's phone
-- number against the cash-pay storefront (shop_customers), in addition
-- to the existing clinical patients lookup:
--
--   1. Add a plaintext E.164 phone column + lookup index to
--      shop_customers. Storefront phone IS collected at Stripe Checkout
--      (phone_number_collection) but was never persisted; the webhook
--      now writes it here going forward. Plaintext, mirroring
--      patients.phone_e164 — migration 0025 removed PHI column-level
--      encryption and the phone HMAC table, so there is no new
--      encryption here by design.
--
--   2. Fix a latent type mismatch: voice_reorder_sessions.shop_customer_id
--      was declared uuid (0134) but shop_customers' primary key
--      (customer_id) is text. A text id cannot be written into a uuid
--      column. The column is nullable, unconstrained, and always-null in
--      production today, so the type change is safe.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "phone_e164" varchar(20);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customers_phone_e164_idx"
  ON "resupply"."shop_customers" ("phone_e164")
  WHERE "phone_e164" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."voice_reorder_sessions"
  ALTER COLUMN "shop_customer_id" TYPE text USING "shop_customer_id"::text;
