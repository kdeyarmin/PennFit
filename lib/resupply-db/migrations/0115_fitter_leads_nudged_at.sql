-- 0115_fitter_leads_nudged_at — track which fitter_leads rows the
-- abandoned-flow re-engagement worker has already emailed.
--
-- Why a column and not a separate log table:
--   The lifecycle is binary — "have we nudged yet?" — and we never
--   nudge a row twice. A single timestamp column is the smallest
--   shape that captures that and lets the dispatcher's WHERE
--   `nudged_at IS NULL` predicate use the row's existing index.
--
-- The dispatcher only emails rows whose `email` does not appear in
-- `public.orders.patient_email`, so a row that already converted
-- gets skipped without ever being stamped — which is fine; we
-- never re-check it because the dispatcher's date window expires.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "nudged_at" timestamp with time zone;
--> statement-breakpoint

-- The dispatcher's hot query is "rows opted in, not yet nudged,
-- created between 3 and 30 days ago." A partial index on the un-
-- nudged subset keeps it tiny — once a row is stamped it falls out
-- of the index entirely.
CREATE INDEX IF NOT EXISTS "fitter_leads_unnudged_created_idx"
  ON "resupply"."fitter_leads" ("created_at" DESC)
  WHERE "nudged_at" IS NULL AND "marketing_opt_in" = true;
