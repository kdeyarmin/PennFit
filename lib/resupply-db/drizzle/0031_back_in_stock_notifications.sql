CREATE TABLE IF NOT EXISTS "resupply"."shop_back_in_stock_notifications" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "product_id" text NOT NULL,
  "email" text NOT NULL,
  "submitter_ip" text,
  "user_agent" text,
  "notified_at" timestamp with time zone,
  "delivered" boolean NOT NULL DEFAULT false,
  "delivery_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_bis_pending_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("product_id")
  WHERE "notified_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_bis_unique_pending_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("product_id", "email")
  WHERE "notified_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_bis_created_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("created_at" DESC);
