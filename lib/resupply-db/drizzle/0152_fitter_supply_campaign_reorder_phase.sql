-- 0152_fitter_supply_campaign_reorder_phase — extend the fitter
-- supply-campaign journey through post-purchase re-order nurture,
-- and add first-name personalization captured from the patient's
-- first order.
--
-- Why this exists
-- ---------------
-- The 6-touch pre-purchase campaign added in 0151 stops the moment
-- a lead converts (the conversion-attribution worker flips them to
-- 'converted'). That's the right shape for the FIRST sale but it
-- misses the bigger long-term value: every CPAP mask buyer needs
-- recurring supplies (cushions every 30 days, filters monthly,
-- headgear every 6 months, full mask refresh at 6-12 months). A
-- patient who bought once and never came back is leaving real
-- revenue on the table for both the practice and (more importantly)
-- their own therapy hygiene.
--
-- The existing lapsed-customer-winback worker fires at 180+ days —
-- way too late for the first cushion replacement (overdue at 60d)
-- and the first filter (overdue at 45d). Smart-triggers + therapy-
-- night patterns need active therapy-data integration. Maintenance-
-- nudges only handle cleaning, not replacement. The "fit but
-- haven't ordered" cohort that's now becoming "ordered once" needs
-- its own progressive resupply nurture, anchored on first_order_
-- placed_at.
--
-- Journey extension
-- -----------------
-- New stage 'reorder_active' lives between the pre-purchase
-- campaign and the eventual terminal 'converted' state:
--
--   campaign_active  →  (order placed)  →  reorder_active
--   reorder_active   →  (T10 sent)      →  converted
--   reorder_active   →  (unsubscribe)   →  unsubscribed
--   reorder_active   →  (second order)  →  reorder_active (campaign
--                                           keeps running — the
--                                           remaining touches are
--                                           still useful supply
--                                           reminders)
--
-- The same dispatcher worker (artifacts/resupply-api/src/worker/
-- jobs/fitter-supply-campaign.ts) drains both stages; touch_index
-- 1-6 are pre-purchase, 7-10 are post-purchase re-order. Touch
-- offsets for the re-order phase are anchored on
-- first_order_placed_at, not completed_at.
--
-- Personalization column
-- ----------------------
-- The pre-purchase phase can't personalize by name (we collect only
-- email at /consent). Once the patient places an order we DO have
-- their name on public.orders.patient_name; the conversion-
-- attribution worker now pulls the first word into
-- fitter_leads.first_name so the re-order touches can open with
-- "Hi Sarah" — A/B benchmarks across DME marketing show a 20-40%
-- open-rate lift from first-name personalization in the subject
-- line alone. Nullable because the column is empty for leads who
-- never converted and for legacy rows pre-this-migration.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_name" text;
--> statement-breakpoint

-- Extend the journey_stage enum with 'reorder_active'.
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
    'converted',
    'unsubscribed',
    'expired'
  ));
--> statement-breakpoint

-- The dispatcher's hot-path partial index (from 0151) only matched
-- journey_stage='campaign_active'. Re-create it to cover the
-- post-purchase phase too — re-order rows now also need to be
-- scanned when their next touch is due.
DROP INDEX IF EXISTS "resupply"."fitter_leads_campaign_due_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_leads_campaign_due_idx"
  ON "resupply"."fitter_leads" ("next_campaign_touch_at")
  WHERE "journey_stage" IN ('campaign_active', 'reorder_active')
    AND "next_campaign_touch_at" IS NOT NULL
    AND "unsubscribed_at" IS NULL;
