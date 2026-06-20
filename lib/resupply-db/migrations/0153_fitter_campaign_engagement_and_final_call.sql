-- 0153_fitter_campaign_engagement_and_final_call — engagement
-- tracking + cold-lead reactivation.
--
-- Two extensions to the supply-campaign machinery added in 0151/0152:
--
-- 1. Engagement signal
-- --------------------
-- We've been sending blind so far — no record of who opens the
-- emails. Adding a self-hosted 1x1 tracking pixel (GET /shop/track/o)
-- gives us a per-lead engagement counter. The signal is noisy
-- (Apple Mail Privacy Protection pre-fetches images; Outlook
-- desktop blocks them) but ordinal: a lead with 5 image loads is
-- more engaged than one with 0. Used for "hot lead" detection.
--
-- New columns:
--   * engagement_score — running count of opens recorded against
--     this lead. Increment-only; never decreases. Used by the
--     hot-lead transition + admin sort.
--   * hot_lead_at — stamped the first time engagement_score crosses
--     HOT_LEAD_THRESHOLD (3 opens) without a placed order. Once
--     stamped it stays stamped even if the lead later converts —
--     ops history of "we knew this one was hot before they bought."
--
-- 2. Cold-lead reactivation (T11 — final call)
-- --------------------------------------------
-- The 6-touch pre-purchase campaign ends at day 60. Some patients
-- need MORE time to decide (insurance, holiday, family discussion).
-- We currently leave them at 'expired' until the lapsed-customer-
-- winback picks them up at 180+d — but lapsed-customer-winback only
-- targets patients who ALREADY bought; an expired fitter lead is
-- never picked up at all. Closing that gap with one final-call
-- email at expired+90d (so total elapsed = 150d since fit) carries
-- almost no marginal cost (the lead is opted in, the SendGrid send
-- is < 1¢) and benchmarks show single-digit conversion lift on the
-- cohort.
--
-- New stage 'final_call_pending' sits between 'campaign_active' and
-- 'expired'. Transition shape:
--
--   campaign_active  → (T6 sent) → final_call_pending (T11 due
--                                  at last_campaign_touch_at + 90d)
--   final_call_pending → (T11 sent) → expired (truly terminal)
--   final_call_pending → (unsubscribe) → unsubscribed
--   final_call_pending → (order placed) → reorder_active
--
-- The dispatcher's scan filter (and the hot-path partial index)
-- expand to include 'final_call_pending'.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "engagement_score" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "hot_lead_at" timestamp with time zone;
--> statement-breakpoint

-- Extend the journey_stage enum with 'final_call_pending'.
ALTER TABLE "resupply"."fitter_leads"
  DROP CONSTRAINT IF EXISTS "fitter_leads_journey_stage_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."fitter_leads"
  ADD CONSTRAINT "fitter_leads_journey_stage_enum"
  CHECK ("journey_stage" IN (
    'consent',
    'completed',
    'campaign_active',
    'reorder_active',
    'final_call_pending',
    'converted',
    'unsubscribed',
    'expired'
  ));
--> statement-breakpoint

-- Update the dispatcher's hot-path partial index to cover the new
-- stage. The prior index (created in 0152) excluded
-- final_call_pending rows, so T11 sends would scan the full table.
DROP INDEX IF EXISTS "resupply"."fitter_leads_campaign_due_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_leads_campaign_due_idx"
  ON "resupply"."fitter_leads" ("next_campaign_touch_at")
  WHERE "journey_stage" IN (
      'campaign_active',
      'reorder_active',
      'final_call_pending'
    )
    AND "next_campaign_touch_at" IS NOT NULL
    AND "unsubscribed_at" IS NULL;
--> statement-breakpoint

-- Hot-lead admin filter: "show me leads we should call NOW."
-- Partial because the hot-lead set is small (a single-digit fraction
-- of the total fitter_leads table) and we only ever query for
-- non-null hot_lead_at.
CREATE INDEX IF NOT EXISTS "fitter_leads_hot_lead_idx"
  ON "resupply"."fitter_leads" ("hot_lead_at" DESC)
  WHERE "hot_lead_at" IS NOT NULL;
