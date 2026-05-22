-- 0155_fitter_campaign_touch_metrics — per-touch open count,
-- per-lead engagement recency, and a metrics view for the admin
-- reporting surface.
--
-- The audit machinery built so far records:
--   * fitter_campaign_touches — one row per send (status sent /
--     failed / skipped), unique on (lead_id, touch_index, channel).
--     Knows WHEN a touch shipped but not whether it was opened.
--   * fitter_campaign_clicks — one row per click. Knows
--     which CTA + which touch was clicked.
--   * fitter_leads.engagement_score — running counter of opens +
--     5x clicks for hot-lead detection.
--
-- What's missing for "which touch converts best" reporting:
--   * Per-touch open count. We bump engagement_score on the LEAD
--     when the pixel loads, but never record WHICH touch was
--     opened. That makes "T4 had a higher open rate than T2"
--     unanswerable from current data.
--   * Per-lead engagement recency. The score is a cumulative count
--     but doesn't say "opened 3 hours ago" — and recency matters
--     enormously for CSR triage.
--
-- This migration plugs both gaps, then exposes a view that
-- aggregates per-touch sends + opens + clicks for the admin
-- metrics endpoint.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD COLUMN IF NOT EXISTS "open_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- First + last open timestamps on the per-touch row. Lets a
-- timeline query say "opened the discount email at 2:47 PM" with
-- exact times rather than "opened sometime."
ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD COLUMN IF NOT EXISTS "first_opened_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD COLUMN IF NOT EXISTS "last_opened_at" timestamp with time zone;
--> statement-breakpoint

-- Per-lead engagement recency. Stamped from the open + click
-- endpoints; supports the admin queue's "last engagement"
-- column without joining to the touches/clicks tables.
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "last_open_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "last_click_at" timestamp with time zone;
--> statement-breakpoint

-- Atomic per-touch open-count bump. PostgREST's UPDATE expression
-- syntax doesn't easily express x = x + 1 over the wire (read-
-- modify-write loses concurrent bumps), so we expose this via an
-- RPC the open-tracking endpoint can call in a single round-trip.
-- LANGUAGE sql STABLE is wrong — this mutates state; LANGUAGE sql
-- VOLATILE (the default) is correct.
CREATE OR REPLACE FUNCTION "resupply"."record_fitter_touch_open"(
  p_lead_id text,
  p_touch_index integer
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE "resupply"."fitter_campaign_touches"
  SET open_count = open_count + 1,
      first_opened_at = COALESCE(first_opened_at, now()),
      last_opened_at = now()
  WHERE lead_id = p_lead_id
    AND touch_index = p_touch_index
    AND channel = 'email';
$$;
--> statement-breakpoint

-- Per-touch metrics view. The LEFT JOIN against generate_series
-- means every touch_index from 1..11 returns a row even when no
-- data has accumulated yet — important so the admin UI doesn't
-- have to invent zero rows on the client side.
--
-- Channel filter: opens only happen via the email pixel; we
-- exclude SMS rows from the sends denominator on the open-rate
-- calculation by filtering channel='email' in the sends sub-
-- query. The view returns a single touch_index column with
-- separate columns for email sends, sms sends, etc. so the UI
-- can compute its own rates.
DROP VIEW IF EXISTS "resupply"."fitter_campaign_touch_metrics";
--> statement-breakpoint
CREATE VIEW "resupply"."fitter_campaign_touch_metrics" AS
SELECT
  ti.touch_index,
  COALESCE(em.sends, 0) AS email_sends,
  COALESCE(em.failures, 0) AS email_failures,
  COALESCE(em.opens, 0) AS opens,
  COALESCE(sm.sends, 0) AS sms_sends,
  COALESCE(sm.failures, 0) AS sms_failures,
  COALESCE(cl.clicks, 0) AS clicks
FROM generate_series(1, 11) ti(touch_index)
LEFT JOIN (
  SELECT
    touch_index,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures,
    COALESCE(SUM(open_count), 0) AS opens
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'email'
  GROUP BY touch_index
) em USING (touch_index)
LEFT JOIN (
  SELECT
    touch_index,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'sms'
  GROUP BY touch_index
) sm USING (touch_index)
LEFT JOIN (
  SELECT touch_index, COUNT(*) AS clicks
  FROM "resupply"."fitter_campaign_clicks"
  GROUP BY touch_index
) cl USING (touch_index);
