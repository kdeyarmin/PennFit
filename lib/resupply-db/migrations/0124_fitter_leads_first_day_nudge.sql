-- 0124_fitter_leads_first_day_nudge — track a sooner re-engagement
-- nudge for the in-funnel patient who started a fitting in the last
-- 24 hours but hasn't ordered.
--
-- Why a SECOND nudged_at column
-- -----------------------------
-- The existing `nudged_at` column is consumed by the 3–30 day
-- re-engagement dispatcher. That worker scans for nudged_at IS NULL,
-- so reusing it would force a choice: either the first-day nudge
-- "steals" the patient from the 3–30d dispatcher (the patient who
-- ignored the first-day nudge gets nothing later), or vice versa.
--
-- Both nudges have a meaningful place in the funnel:
--
--   * First-day nudge (this column) — the patient was actively
--     fitting hours ago, the camera + measurements may even still
--     be cached on their device. "Want a hand finishing?" hits
--     while the intent is still warm.
--
--   * 3-30 day nudge (existing nudged_at) — the patient never came
--     back. "Pick up where you left off" with the resume-from-
--     consent URL. Different copy, different cohort.
--
-- A patient can receive BOTH (one at 24h, one at 3-30d) — total of
-- two nudges per lead row, which is well inside any reasonable
-- marketing cadence for an opted-in lead.
--
-- Index posture
-- -------------
-- Partial index on the un-nudged subset matches the dispatcher's
-- hot scan; once a row is stamped it falls out entirely. Bounded
-- by the 18-30 hour window the dispatcher uses, so the index
-- stays tiny regardless of total fitter_leads volume.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_day_nudged_at"
    timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fitter_leads_first_day_unnudged_idx"
  ON "resupply"."fitter_leads" ("created_at" DESC)
  WHERE "first_day_nudged_at" IS NULL
    AND "marketing_opt_in" = true;
