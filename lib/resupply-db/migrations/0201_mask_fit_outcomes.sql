-- 0201_mask_fit_outcomes — RT #22a: mask-fit confirmation loop (capture).
--
-- A post-delivery micro-survey: "how's the mask fitting?" → good /
-- leaking / uncomfortable, with an optional comment. Captured from a
-- signed link in the delivery-followup email (same HMAC-token pattern as
-- the NPS rating, migration 0127) — no login. Surfaced to RTs (slice 2)
-- so a poor fit becomes a follow-up before it becomes a return or a
-- non-adherent patient; and accumulated as the training signal the
-- recommendation-engine tuning loop (#22b) flies blind on today.
--
-- Mirrors shop_order_nps_responses: bound to a shop_orders row, multiple
-- rows allowed per order (a patient can re-answer), ip/ua for spam
-- triage. Adds an RT triage state machine (new → reviewed → actioned).
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."mask_fit_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" text NOT NULL
    REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE,
  -- The micro-survey answer.
  "fit_outcome" text NOT NULL,
  "comment" text,
  -- RT triage. 'new' until an RT works it; non-'good' outcomes are the
  -- worklist. 'actioned' = an intervention / outreach was started.
  "status" text NOT NULL DEFAULT 'new',
  "reviewed_by_email" text,
  "reviewed_at" timestamp with time zone,
  -- IP + UA for ops triage on suspected spam responses (no PHI).
  "submitter_ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mask_fit_outcomes_fit_outcome_enum"
    CHECK ("fit_outcome" IN ('good', 'leaking', 'uncomfortable')),
  CONSTRAINT "mask_fit_outcomes_status_enum"
    CHECK ("status" IN ('new', 'reviewed', 'actioned')),
  CONSTRAINT "mask_fit_outcomes_comment_length"
    CHECK ("comment" IS NULL OR char_length("comment") <= 2000)
);
--> statement-breakpoint

-- RT worklist: newest non-resolved poor-fit outcomes first.
CREATE INDEX IF NOT EXISTS "mask_fit_outcomes_status_created_idx"
  ON "resupply"."mask_fit_outcomes" ("status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mask_fit_outcomes_order_idx"
  ON "resupply"."mask_fit_outcomes" ("order_id");
