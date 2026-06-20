-- 0407_newsletter_demo_drip — demo-lead nurture drip state.
--
-- Why
-- ---
-- The "Breathe" marketing site captures a visitor's email when they open
-- the self-serve demo (public.newsletter_subscribers, source =
-- 'breathe-demo'; written by POST /demo-lead). Until now that was a
-- capture-only list — no email ever went back out. This adds the small
-- amount of per-lead state the demo-drip worker needs to walk each lead
-- through a short, branded welcome + follow-up sequence exactly once.
--
-- Columns
-- -------
-- * demo_drip_stage — how many drip emails this lead has been sent.
--     0 = nothing sent yet (welcome is due), 1 = welcome sent,
--     2 = first follow-up sent, 3 = sequence complete. The worker
--     atomically bumps this with a guarded UPDATE so a crash mid-tick
--     can't double-send.
-- * demo_drip_last_sent_at — when the most recent drip email went out;
--     drives the "wait N days before the next touch" spacing.
--
-- These default to 0 / NULL, so existing rows and the OTHER writers of
-- this shared list (the Learn-page newsletter signup, source =
-- 'learn-newsletter') are unaffected — the drip worker only ever scans
-- rows with source = 'breathe-demo'.
--
-- PHI: none — a volunteered marketing address, same posture as the rest
-- of newsletter_subscribers.

ALTER TABLE "newsletter_subscribers"
  ADD COLUMN IF NOT EXISTS "demo_drip_stage" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "newsletter_subscribers"
  ADD COLUMN IF NOT EXISTS "demo_drip_last_sent_at" timestamp with time zone;
--> statement-breakpoint
-- Partial index over just the active demo-drip cohort keeps the hourly
-- worker scan cheap as the global marketing list grows.
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_demo_drip_idx"
  ON "newsletter_subscribers" USING btree ("demo_drip_stage", "demo_drip_last_sent_at")
  WHERE "source" = 'breathe-demo' AND "unsubscribed_at" IS NULL;
