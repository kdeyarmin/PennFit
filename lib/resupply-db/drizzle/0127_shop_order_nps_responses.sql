-- 0127_shop_order_nps_responses — capture the patient's NPS-style
-- response to the post-delivery follow-up email.
--
-- Why
-- ---
-- The shop-order.delivery-followup worker already emails every
-- patient 3-14 days after their parcel arrives ("how did it go?").
-- Today the email has yes/no/return CTAs but no structured signal
-- back — we get a feel for satisfaction only when someone replies
-- to the email or starts a return. An NPS-style 0-10 score buried
-- in the same email captures a structured response from the much
-- larger silent cohort.
--
-- Why a dedicated table (not a column on shop_orders)
-- ---------------------------------------------------
-- A patient can plausibly answer the same delivery follow-up
-- multiple times (clicking 9 in one email, then 7 a week later
-- because they tried again). We want the full history, not just
-- the last value. One row per response keeps the data
-- analytically tractable and lets admin dashboards roll up by
-- day, by mask, by carrier without per-row JSONB unpacking.
--
-- Capture URL shape
-- -----------------
-- The email links to /nps?orderId=<id>&score=<0..10>. The page
-- POSTs the score to /api/orders/:orderId/nps with a short-lived
-- HMAC token derived from the order id + the install's audit HMAC
-- key — same key already in place for tamper-evident audit chains.
-- That keeps the surface unauthenticated (patients click straight
-- from email, no login) while still preventing a hostile actor
-- from flooding the table with fake responses.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_order_nps_responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" text NOT NULL
    REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE,
  "score" smallint NOT NULL,
  "comment" text,
  -- IP + UA for ops triage on suspected spam responses.
  "submitter_ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_order_nps_responses_score_range"
    CHECK ("score" >= 0 AND "score" <= 10),
  CONSTRAINT "shop_order_nps_responses_comment_length"
    CHECK ("comment" IS NULL OR char_length("comment") <= 2000)
);
--> statement-breakpoint

-- Hot read pattern: per-order rollup for the admin order-detail
-- page, newest first.
CREATE INDEX IF NOT EXISTS "shop_order_nps_responses_order_idx"
  ON "resupply"."shop_order_nps_responses" ("order_id", "created_at" DESC);
--> statement-breakpoint

-- Date-bucket scans for analytics dashboards.
CREATE INDEX IF NOT EXISTS "shop_order_nps_responses_created_idx"
  ON "resupply"."shop_order_nps_responses" ("created_at" DESC);
