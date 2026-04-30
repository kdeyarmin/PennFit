-- Server-side mirror of a SIGNED-IN shop visitor's localStorage cart,
-- used to drive a single 24h "you left items in your cart" SendGrid
-- nudge AND to rehydrate the cart on a different device when the
-- patient clicks the email link.
--
-- One row per Clerk user (clerk_user_id UNIQUE). The frontend PUTs
-- on a debounce; the admin dispatcher scans on updated_at and
-- suppresses on recovered_at / reminded_at / cleared_at.
--
-- Pure additive change (CREATE TABLE only). Matches ADR 003 — this
-- codebase uses versioned hand-authored migrations because db:push
-- silently rewrites columns once PHI lands.
CREATE TABLE "resupply"."shop_abandoned_carts" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "clerk_user_id" text NOT NULL,
  "email" text,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subtotal_cents" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reminded_at" timestamp with time zone,
  "recovered_at" timestamp with time zone,
  "cleared_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_abandoned_carts_clerk_user_id_unique" UNIQUE ("clerk_user_id")
);

CREATE INDEX "shop_abandoned_carts_updated_at_idx"
  ON "resupply"."shop_abandoned_carts" ("updated_at");
