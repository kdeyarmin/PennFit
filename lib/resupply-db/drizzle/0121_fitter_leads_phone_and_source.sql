-- 0121_fitter_leads_phone_and_source — capture SMS opt-in + lead source
-- on the public fitter_leads table.
--
-- Why phone
-- ---------
-- /consent today captures email only. SMS open rates are 4-5× email
-- across every demographic and especially for the older sleep-apnea
-- patient cohort. An optional phone field on /consent turns those
-- otherwise-unreachable patients into a recoverable channel for the
-- abandoned-flow re-engagement dispatcher. Email stays mandatory;
-- phone is purely additive.
--
-- Why a `source` column
-- ---------------------
-- fitter_leads originally meant "abandoned the /consent → /capture
-- flow." We now want to reuse the same lead surface for adjacent
-- top-of-funnel captures: the sleep-apnea quiz on /learn (high-
-- intent prospects who took our self-triage tool) and the future
-- insurance benefit estimator. Splitting them into separate tables
-- would duplicate the rate-limit + honeypot + re-engagement
-- infrastructure for no real benefit. A `source` column lets the
-- re-engagement worker pick the right template per acquisition
-- point.
--
-- Allowed values:
--   'consent'        — original /consent page (default for back-
--                      compat; legacy rows pre-this-migration are
--                      treated as 'consent' via the column default).
--   'sleep_apnea_quiz' — POST /shop/quiz-leads, sleep apnea quiz on
--                      /learn/sleep-apnea-quiz.
--   'insurance_quote' — future insurance benefit estimator page.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "phone_e164" text;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "sms_opt_in" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'consent';
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  DROP CONSTRAINT IF EXISTS "fitter_leads_source_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."fitter_leads"
  ADD CONSTRAINT "fitter_leads_source_enum"
  CHECK ("source" IN (
    'consent',
    'sleep_apnea_quiz',
    'insurance_quote'
  ));
--> statement-breakpoint

-- Lookup by phone — same shape as email lookup, used when an inbound
-- SMS arrives from a number we've seen on a lead row but not yet
-- linked to a patient.
CREATE INDEX IF NOT EXISTS "fitter_leads_phone_idx"
  ON "resupply"."fitter_leads" ("phone_e164")
  WHERE "phone_e164" IS NOT NULL;
--> statement-breakpoint

-- Source-aware dispatcher scan: rows opted in, not yet nudged,
-- aged into the window — broken down by source so each source can
-- run its own copy / cadence.
CREATE INDEX IF NOT EXISTS "fitter_leads_unnudged_source_idx"
  ON "resupply"."fitter_leads" ("source", "created_at" DESC)
  WHERE "nudged_at" IS NULL AND "marketing_opt_in" = true;
