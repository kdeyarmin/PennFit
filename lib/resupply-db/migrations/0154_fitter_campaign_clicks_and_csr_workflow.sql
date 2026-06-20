-- 0154_fitter_campaign_clicks_and_csr_workflow — click tracking +
-- CSR outreach workflow for the fitter supply campaign.
--
-- Two extensions on top of mig 0153's open-tracking + hot-lead
-- detection:
--
-- 1. Click tracking
-- -----------------
-- Open-tracking gives us a noisy "did the email reach them"
-- signal. Click-tracking gives us a much stronger "did the message
-- resonate" signal — the patient deliberately tapped a CTA. A
-- single click should outweigh dozens of opens in any reasonable
-- lead-scoring model.
--
-- Per-click audit row (one per CTA click) lets ops see which touch
-- drives the most clicks across the cohort. Useful for tuning
-- subject lines + body copy with measurable feedback rather than
-- intuition.
--
-- 2. CSR contact workflow
-- -----------------------
-- Hot-lead detection (mig 0153) tells ops WHO to call but doesn't
-- close the loop. csr_contacted_at + csr_contacted_by record when
-- a CSR has acted; admin filters the hot-leads queue by
-- contacted-state so the same lead doesn't sit in the queue
-- forever. We're not building a full CRM here — we just want one
-- field per row that says "human reached out, here's when, here's
-- who."
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "click_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- CSR outreach stamp. Free-text "by" so a deleted admin row
-- doesn't break the FK (matches the audit-log posture used by the
-- rest of the codebase).
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "csr_contacted_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "csr_contacted_by" text;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Per-click audit table.
-- ---------------------------------------------------------------
-- One row per CTA click. `link_key` is the closed-enum slug of the
-- CTA destination ('results', 'shop', 'subscribe', 'refer',
-- 'promo'), NOT the literal target URL — the worker passes the
-- slug into the signed click token so a tampered token can't
-- redirect to an arbitrary destination.
CREATE TABLE IF NOT EXISTS "resupply"."fitter_campaign_clicks" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "lead_id" text NOT NULL
    REFERENCES "resupply"."fitter_leads"("id") ON DELETE CASCADE,
  "touch_index" integer NOT NULL,
  "link_key" text NOT NULL,
  "clicked_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Best-effort source IP for forensics on suspicious click
  -- patterns. Nullable because we don't always have it (e.g.
  -- behind a misbehaving proxy).
  "submitter_ip" text
);
--> statement-breakpoint

-- Touch-index reporting: "what's the click-through rate on T4?"
CREATE INDEX IF NOT EXISTS "fitter_campaign_clicks_touch_idx"
  ON "resupply"."fitter_campaign_clicks" ("touch_index", "clicked_at" DESC);
--> statement-breakpoint

-- Per-lead lookup: "what did this patient click?"
CREATE INDEX IF NOT EXISTS "fitter_campaign_clicks_lead_idx"
  ON "resupply"."fitter_campaign_clicks" ("lead_id", "clicked_at" DESC);
--> statement-breakpoint

-- Admin hot-leads queue: "which hot leads still need a CSR call?"
-- Partial index because the un-contacted hot subset is tiny — once
-- a CSR stamps csr_contacted_at the row falls out of the index
-- entirely.
CREATE INDEX IF NOT EXISTS "fitter_leads_hot_uncontacted_idx"
  ON "resupply"."fitter_leads" ("hot_lead_at" DESC)
  WHERE "hot_lead_at" IS NOT NULL
    AND "csr_contacted_at" IS NULL
    AND "unsubscribed_at" IS NULL;
