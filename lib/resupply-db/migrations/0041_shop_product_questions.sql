-- shop_product_questions — customer-submitted questions about a
-- shop product, answered by CSRs (Phase A.5 / feature #24 extension).
--
-- Mirrors shop_reviews:
--   * One row per question (no per-user uniqueness — a customer can
--     ask multiple questions on the same product over time).
--   * Lifecycle: pending → answered (publicly visible) | rejected.
--   * Bodies are public-shop content; no PHI on the cash-pay surface.
--
-- Why not reuse shop_reviews with a `kind` discriminator: reviews
-- are 1-per-customer-per-product and rated 1..5; questions can be
-- many-per-customer-per-product and have an admin-authored ANSWER
-- body that reviews don't. Different shape, different lifecycle —
-- two narrow tables stay easier to reason about.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_product_questions" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "product_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "asker_display_name" text NOT NULL,
  "asker_email" text NOT NULL,
  "question_body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "answer_body" text,
  "answered_by_email" text,
  "answered_by_user_id" text,
  "answered_at" timestamp with time zone,
  "moderation_note" text,
  "moderated_at" timestamp with time zone,
  "moderated_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_product_questions_status_enum"
    CHECK ("status" IN ('pending','answered','rejected'))
);

-- Public reads filter by product_id + status='answered', newest-first.
CREATE INDEX IF NOT EXISTS "shop_product_questions_product_status_idx"
  ON "resupply"."shop_product_questions" ("product_id", "status");

-- Admin moderation queue scans status='pending' ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS "shop_product_questions_status_created_idx"
  ON "resupply"."shop_product_questions" ("status", "created_at");

-- Customer's own asked-questions view ("My questions").
CREATE INDEX IF NOT EXISTS "shop_product_questions_customer_idx"
  ON "resupply"."shop_product_questions" ("customer_id", "created_at" DESC);
