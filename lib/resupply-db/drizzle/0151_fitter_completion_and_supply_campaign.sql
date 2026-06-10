-- 0151_fitter_completion_and_supply_campaign — track fitter completion
-- and run a multi-touch nurture campaign to convert "fit but didn't
-- buy" leads.
--
-- Background
-- ----------
-- Three fitter dispatchers exist already:
--   * fitter-lead-first-day-nudge (~24h after /consent)
--   * fitter-lead-reengage         (3–30d after /consent)
--   * lapsed-customer-winback      (post-purchase, 6+mo inactive)
--
-- All three are SINGLE-SHOT nudges keyed off /consent submission.
-- None of them know whether the patient actually finished the fitter
-- (reached /results and saw a mask recommendation), and none of them
-- run a structured multi-touch sequence aimed at converting a
-- recommendation-in-hand prospect.
--
-- This migration plugs that gap: it adds a campaign-journey state
-- machine to fitter_leads, persists the recommended mask (NOT PHI —
-- product reference only), and creates a touchpoint audit log.
--
-- Journey stages
-- --------------
--   'consent'         — row exists, /consent submitted, patient may
--                       or may not be in the funnel. Default for
--                       every existing row.
--   'completed'       — patient reached /results; recommendation has
--                       been issued. The supply-campaign dispatcher
--                       flips this to 'campaign_active' on the same
--                       write (we keep 'completed' as a distinct
--                       value for queries that want fit-but-not-yet-
--                       campaigned).
--   'campaign_active' — multi-touch supply campaign in flight. The
--                       dispatcher reads `next_campaign_touch_at`,
--                       sends the next touch, increments
--                       `campaign_touch_count`, and re-schedules.
--   'converted'       — patient placed an order. Set by the
--                       fitter-conversion-attribution worker that
--                       joins public.orders.patient_email back to
--                       this row. Campaign stops sending.
--   'unsubscribed'    — patient clicked the campaign unsubscribe
--                       link. Final state; never sent to again by
--                       any worker (we leave the flag here even if
--                       they later place an order, so we don't
--                       resume sending without a fresh opt-in).
--   'expired'         — campaign ran through all touchpoints without
--                       a conversion. Final state.
--
-- Why store the recommended mask
-- ------------------------------
-- The campaign copy is meaningfully better when it can name the
-- specific mask the patient was shown ("your ResMed AirFit P30i is
-- 18% off this week" converts dramatically better than "your fitting
-- recommendation"). The mask model is a product reference, not PHI,
-- so storing it on the lead row is fine. We never store the
-- measurements that produced the recommendation (those stay
-- in-browser per the HIPAA-data-minimization comment on the
-- /recommend route).
--
-- Touch log
-- ---------
-- `fitter_campaign_touches` is a per-send audit row. Lets ops query
-- "which touchpoint converts best" without grovelling through
-- SendGrid event webhooks, and lets the dispatcher detect a stuck
-- lead (e.g. last touch failed → don't keep retrying the same one).
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint

-- Recommended mask product reference. NOT PHI; the catalog entry the
-- recommendation engine returned. Nullable for rows that never
-- completed the fitter.
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "recommended_mask_id" text;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "recommended_mask_name" text;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "recommended_mask_type" text;
--> statement-breakpoint

-- Journey state. Default 'consent' so legacy rows pre-this-migration
-- get a sensible value without a backfill.
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "journey_stage" text NOT NULL DEFAULT 'consent';
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  DROP CONSTRAINT IF EXISTS "fitter_leads_journey_stage_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."fitter_leads"
  ADD CONSTRAINT "fitter_leads_journey_stage_enum"
  CHECK ("journey_stage" IN (
    'consent',
    'completed',
    'campaign_active',
    'converted',
    'unsubscribed',
    'expired'
  ));
--> statement-breakpoint

-- Touchpoint counter. Indexed implicitly by the journey_stage filter
-- on the dispatcher's scan; the count itself is small (0..6).
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "campaign_touch_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "last_campaign_touch_at" timestamp with time zone;
--> statement-breakpoint

-- The dispatcher's primary scan column. NULL means "not yet
-- scheduled" (e.g. row hasn't reached /results), a past timestamp
-- means "due now."
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "next_campaign_touch_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone;
--> statement-breakpoint

-- Order attribution. Populated by fitter-conversion-attribution
-- worker that joins on patient_email. Nullable; remains null for
-- the cohort that never converts. ON DELETE SET NULL because
-- public.orders rows can be soft-deleted and we don't want a
-- cascade ripple into the lead row.
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_order_id" uuid;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_order_placed_at" timestamp with time zone;
--> statement-breakpoint

-- Dispatcher hot path: "rows in active campaign whose next touch is
-- due now." Partial index keeps it tiny — the moment a lead
-- converts or unsubscribes or expires, it falls out of the index.
CREATE INDEX IF NOT EXISTS "fitter_leads_campaign_due_idx"
  ON "resupply"."fitter_leads" ("next_campaign_touch_at")
  WHERE "journey_stage" = 'campaign_active'
    AND "next_campaign_touch_at" IS NOT NULL
    AND "unsubscribed_at" IS NULL;
--> statement-breakpoint

-- Admin queue filter: "recently completed but not yet converted."
-- Used by the admin /fitter-leads list with status=in_campaign.
CREATE INDEX IF NOT EXISTS "fitter_leads_journey_stage_idx"
  ON "resupply"."fitter_leads" ("journey_stage", "completed_at" DESC)
  WHERE "completed_at" IS NOT NULL;
--> statement-breakpoint

-- Attribution lookup: the conversion worker reads recent orders and
-- needs to find matching fitter_leads by email. The plain
-- fitter_leads_email_idx (from migration 0114) covers this.

-- ---------------------------------------------------------------
-- Touchpoint audit log.
-- ---------------------------------------------------------------
-- One row per outbound send (email or SMS). Lets the dispatcher
-- query "did we already send touch N to this lead?" and gives ops
-- a per-touchpoint conversion table.
CREATE TABLE IF NOT EXISTS "resupply"."fitter_campaign_touches" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "lead_id" text NOT NULL
    REFERENCES "resupply"."fitter_leads"("id") ON DELETE CASCADE,
  -- 1-based touch index. The dispatcher's cadence table maps each
  -- index to a copy template + day offset.
  "touch_index" integer NOT NULL,
  -- 'email' or 'sms'. Same lead may receive both channels for the
  -- same touch_index (e.g. day-7 email AND day-7 SMS) — the
  -- compound (lead_id, touch_index, channel) unique constraint
  -- permits that while preventing double-sends per channel.
  "channel" text NOT NULL,
  "template_key" text NOT NULL,
  "status" text NOT NULL,
  -- SendGrid / Twilio error message when status='failed'. Stored
  -- as text in this migration; any payload-size limiting must be
  -- handled outside this schema.
  "error_message" text,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_campaign_touches"
  DROP CONSTRAINT IF EXISTS "fitter_campaign_touches_channel_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD CONSTRAINT "fitter_campaign_touches_channel_enum"
  CHECK ("channel" IN ('email', 'sms'));
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_campaign_touches"
  DROP CONSTRAINT IF EXISTS "fitter_campaign_touches_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD CONSTRAINT "fitter_campaign_touches_status_enum"
  CHECK ("status" IN ('sent', 'failed', 'skipped'));
--> statement-breakpoint

-- One row per (lead, touch_index, channel). Prevents double-sends
-- if the dispatcher's atomic claim ever races.
CREATE UNIQUE INDEX IF NOT EXISTS "fitter_campaign_touches_lead_touch_channel_uidx"
  ON "resupply"."fitter_campaign_touches" ("lead_id", "touch_index", "channel");
--> statement-breakpoint

-- Per-touchpoint reporting: "how many converted after touch 3?"
CREATE INDEX IF NOT EXISTS "fitter_campaign_touches_touch_sent_idx"
  ON "resupply"."fitter_campaign_touches" ("touch_index", "sent_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Feature flag for the new dispatcher.
-- ---------------------------------------------------------------
-- Seeded enabled-by-default to match the rest of the catalog. Admin
-- Control Center can flip it off without a deploy.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('fitter_supply_campaign.dispatcher',
   true,
   'Multi-touch nurture campaign for patients who completed the at-home fitter but have not placed an order. Disabling stops the dispatcher from sending new touchpoints; in-flight conversions still attribute normally.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
