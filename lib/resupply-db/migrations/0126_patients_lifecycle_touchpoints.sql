-- 0126_patients_lifecycle_touchpoints — track once-yearly birthday +
-- sleep-therapy anniversary celebration emails per patient.
--
-- Why
-- ---
-- Adherence-coaching research is unambiguous: calendar touchpoints
-- ("happy birthday from the people who care about your sleep") have
-- some of the highest open + click rates of any DME-supplier email
-- AND correlate with materially higher long-tail retention. The
-- patient_therapy_milestones table from 0120 fires on *therapy
-- counts* (100 nights, 365 nights, first adherence month); these
-- are different signals and need their own once-per-year stamps.
--
--   birthday_email_year_sent       — 4-digit calendar year of the
--                                    most recent birthday email
--                                    sent. The cron compares against
--                                    the current year and skips
--                                    patients already stamped.
--   sleep_anniversary_year_sent    — same shape, separate counter,
--                                    keyed on the calendar year
--                                    matching the patient's first-
--                                    therapy-night anniversary.
--
-- Storing the year (vs. a timestamp) keeps the "did we already send
-- this cycle?" check trivial and survives clock drift / re-runs in
-- the same day — same pattern used by deductible_reset_year on
-- shop_customers.
--
-- Both columns are nullable; legacy rows pre-this-migration are
-- treated as "never sent" by the worker.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "birthday_email_year_sent" integer;
--> statement-breakpoint

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "sleep_anniversary_year_sent" integer;
