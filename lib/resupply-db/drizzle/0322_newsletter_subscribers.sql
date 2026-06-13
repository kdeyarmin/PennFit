-- 0322_newsletter_subscribers — marketing email capture for the
-- storefront newsletter signup.
--
-- Why
-- ---
-- The Learn-page newsletter component has been POSTing to
-- /api/newsletter/subscribe since it shipped, but no backend route or
-- table existed — every address was silently dropped while the UI
-- showed "you're on the list". This table backs the real endpoint.
--
-- Shape notes
-- -----------
-- * public schema, same as the other storefront tables (orders,
--   reminder_subscriptions) — this is marketing data tied to the shop
--   surface, not the resupply clinical domain.
-- * email is unique (case-insensitively: the route lowercases before
--   insert) so repeat submissions upsert instead of duplicating.
-- * `source` records which surface captured the address (e.g.
--   "learn-newsletter") for attribution; free-text but length-capped
--   at the route boundary.
-- * `unsubscribed_at` supports list hygiene without deleting rows
--   (re-subscribing clears it).
--
-- PHI: none — a marketing email address volunteered for content, with
-- no clinical or order linkage.

CREATE TABLE IF NOT EXISTS "newsletter_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "source" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unsubscribed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "newsletter_subscribers_email_unique_idx" ON "newsletter_subscribers" USING btree ("email");
