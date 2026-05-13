-- shop_order_loss_claims — lost-parcel escalation workflow per order.
-- See schema/shop-order-loss-claims.ts for the rationale.

CREATE TABLE IF NOT EXISTS "resupply"."shop_order_loss_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL
    REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE,
  "opened_by_user_id" text,
  "status" varchar(32) NOT NULL DEFAULT 'open',
  "carrier_claim_number" varchar(64),
  "resolution_note" text,
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "carrier_filed_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_order_loss_claims_status_enum"
    CHECK ("status" IN (
      'open',
      'carrier_filed',
      'resolved_refunded',
      'resolved_reshipped',
      'closed_unresolved'
    ))
);

CREATE INDEX IF NOT EXISTS "shop_order_loss_claims_order_idx"
  ON "resupply"."shop_order_loss_claims" ("order_id");

CREATE INDEX IF NOT EXISTS "shop_order_loss_claims_open_idx"
  ON "resupply"."shop_order_loss_claims" ("opened_at")
  WHERE "resolved_at" IS NULL;
