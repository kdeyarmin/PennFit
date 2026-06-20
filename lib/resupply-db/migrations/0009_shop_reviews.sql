-- Customer-submitted product reviews for the cash-pay shop.
--
-- Any signed-in Clerk customer can submit ONE review per product
-- (UNIQUE on clerk_user_id + product_id). Every row starts
-- status='pending' and only becomes publicly visible after an admin
-- approves it. Edits to an approved review reset status back to
-- 'pending' for re-moderation.
--
-- Privacy: review bodies are public-shop content (no PHI on the
-- cash-pay surface). author_display_name is denormalized as
-- "FirstName L." for public rendering. author_email is denormalized
-- for the admin moderation queue ONLY and is never returned by the
-- public read endpoints.
--
-- Pure additive change (CREATE TABLE only). Matches ADR 003 — this
-- codebase uses versioned hand-authored migrations because db:push
-- silently rewrites columns once PHI lands.
CREATE TABLE "resupply"."shop_reviews" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "clerk_user_id" text NOT NULL,
  "product_id" text NOT NULL,
  "rating" integer NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "author_display_name" text NOT NULL,
  "author_email" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "moderation_note" text,
  "moderated_at" timestamp with time zone,
  "moderated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_reviews_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5),
  CONSTRAINT "shop_reviews_status_enum" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX "shop_reviews_clerk_user_id_product_id_unique"
  ON "resupply"."shop_reviews" ("clerk_user_id", "product_id");

CREATE INDEX "shop_reviews_product_id_status_idx"
  ON "resupply"."shop_reviews" ("product_id", "status");

CREATE INDEX "shop_reviews_status_created_at_idx"
  ON "resupply"."shop_reviews" ("status", "created_at");
