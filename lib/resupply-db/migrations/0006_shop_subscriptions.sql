-- shop_subscriptions — local mirror of Stripe Subscriptions for the
-- "Subscribe & Save" / auto-ship flow. See
-- lib/resupply-db/src/schema/shop-subscriptions.ts for the design
-- rationale. New table only; no destructive operations.
CREATE TABLE "resupply"."shop_subscriptions" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "clerk_user_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_customer_id" text,
  "status" text NOT NULL,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "canceled_at" timestamp with time zone,
  "initial_amount_total_cents" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE INDEX "shop_subscriptions_clerk_user_id_idx" ON "resupply"."shop_subscriptions" USING btree ("clerk_user_id");
--> statement-breakpoint
CREATE INDEX "shop_subscriptions_status_idx" ON "resupply"."shop_subscriptions" USING btree ("status");
