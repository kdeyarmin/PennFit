-- 0157_fitter_subject_variants — A/B testing infrastructure for
-- subject-line variants on the supply campaign touches.
--
-- The campaign now has rich engagement instrumentation (opens,
-- clicks, recency, hot-lead detection, cold-skip suppression) but
-- the copy itself remains a single hand-tuned ruleset per touch.
-- A/B testing closes the loop: we ship multiple subject-line
-- variants for a touch, deterministically assign each lead to a
-- variant, and the same engagement-tracking machinery we've
-- already built measures which variant earns more opens + clicks.
--
-- Why deterministic per-(lead, touch) assignment
-- ----------------------------------------------
-- A patient who hits T1 with variant A and T2 with variant B
-- would muddle the open-rate signal on T2 (we couldn't tell
-- whether T2-B did better because of the subject, or because
-- patients who got T1-A were already warmer). Holding variant
-- constant per (lead, touch) is the standard approach; bucket
-- assignment uses a SHA-256 hash of (lead_id, touch_index) mod
-- the variant count so it's stable across worker restarts and
-- evenly distributed across the cohort.
--
-- Storage
-- -------
-- subject_variant_key (text, default 'A') on fitter_campaign_touches
-- AND on fitter_campaign_clicks. The click row's variant key
-- comes from the click-tracking token (signed at email-send
-- time), not from a DB lookup against the touches row — keeps
-- the click endpoint fast + lets us run a variant test even
-- when the touches row write happened to fail.
--
-- Variant key is text not an enum so we're not tied to A/B/C
-- letters. The composer registry decides which keys are valid
-- per touch; storage is permissive.
--
-- Per-variant metrics view
-- ------------------------
-- The existing fitter_campaign_touch_metrics view (mig 0155)
-- collapses across variants. This migration adds a sibling
-- view broken out per (touch_index, subject_variant_key) so the
-- admin UI can render per-variant rows. The variant-agnostic
-- view stays for callers that don't need the breakdown.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD COLUMN IF NOT EXISTS "subject_variant_key" text NOT NULL DEFAULT 'A';
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_campaign_clicks"
  ADD COLUMN IF NOT EXISTS "subject_variant_key" text NOT NULL DEFAULT 'A';
--> statement-breakpoint

-- Per-(touch, variant) metrics view. Same generate_series outer-
-- join structure as the variant-agnostic view so unseen
-- combinations return a zero row. We don't generate a row for
-- every possible variant — only variants that have actually been
-- assigned to a touches row. Empty-variant touches just show
-- the default 'A' row.
DROP VIEW IF EXISTS "resupply"."fitter_campaign_touch_variant_metrics";
--> statement-breakpoint
CREATE VIEW "resupply"."fitter_campaign_touch_variant_metrics" AS
SELECT
  em.touch_index,
  em.subject_variant_key,
  em.sends AS email_sends,
  em.failures AS email_failures,
  em.opens,
  COALESCE(cl.clicks, 0) AS clicks
FROM (
  SELECT
    touch_index,
    subject_variant_key,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures,
    COALESCE(SUM(open_count), 0) AS opens
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'email'
  GROUP BY touch_index, subject_variant_key
) em
LEFT JOIN (
  SELECT
    touch_index,
    subject_variant_key,
    COUNT(*) AS clicks
  FROM "resupply"."fitter_campaign_clicks"
  GROUP BY touch_index, subject_variant_key
) cl
USING (touch_index, subject_variant_key);
--> statement-breakpoint

-- Reporting index: per-variant scans group on these two columns.
-- Without an index PostgREST does a sequential scan over the
-- touches table for every metrics-page render; with one, the
-- view materializes from an index-only path.
CREATE INDEX IF NOT EXISTS "fitter_campaign_touches_touch_variant_idx"
  ON "resupply"."fitter_campaign_touches" ("touch_index", "subject_variant_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fitter_campaign_clicks_touch_variant_idx"
  ON "resupply"."fitter_campaign_clicks" ("touch_index", "subject_variant_key");
