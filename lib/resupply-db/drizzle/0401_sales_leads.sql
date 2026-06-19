-- 0401_sales_leads — leads captured by the CareMetric Breathe B2B platform
-- sales voice agent (and any future platform lead-capture surface).
--
-- PLATFORM-SCOPED, not tenant-scoped: a sales lead is a prospect for the
-- *platform* (a DME business considering CareMetric Breathe), not a patient
-- inside any tenant. So there is intentionally NO org_id — rows are written
-- through the seed-org `.raw()` chokepoint (the same escape hatch
-- tenant-signup-service.ts and the platform billing tables use for
-- platform-global data), never the org-scoped facade (which would append an
-- `org_id` filter and never match).
--
-- No PHI here. A lead carries business contact details (name, company, phone,
-- email) and a free-text message — PII, but not patient health data. The
-- voice agent's audit summaries redact the contact fields; this table is the
-- durable record the super-admins follow up from.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."sales_leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Business contact details. All nullable — a caller may decline to share
  -- everything; we keep whatever we got.
  "contact_name" text,
  "company_name" text,
  "phone_e164" text,
  "email" text,
  -- Which plan they seemed interested in, if any. Constrained to the known
  -- plan codes (matching billing_plans) or NULL.
  "interest_tier" varchar(40),
  -- What they want / their question, in the agent's words. The one required
  -- content field.
  "message" text NOT NULL DEFAULT '',
  -- Ties the lead back to the originating voice call for analytics.
  "twilio_call_sid" text,
  -- Where the lead came from. Defaults to the sales voice agent; future
  -- surfaces (web form, etc.) can set their own value.
  "source" varchar(40) NOT NULL DEFAULT 'voice_sales_agent',
  -- Follow-up lifecycle for the super-admin queue.
  "status" text NOT NULL DEFAULT 'new',
  -- Free-form structured extras (call reason, intent, etc.).
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sales_leads_status_chk"
    CHECK ("status" IN ('new', 'contacted', 'qualified', 'signed_up', 'closed_lost')),
  CONSTRAINT "sales_leads_interest_tier_chk"
    CHECK ("interest_tier" IS NULL OR "interest_tier" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint

-- Newest-first review queue, optionally filtered by status.
CREATE INDEX IF NOT EXISTS "sales_leads_created_idx"
  ON "resupply"."sales_leads" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_leads_status_idx"
  ON "resupply"."sales_leads" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_leads_call_sid_idx"
  ON "resupply"."sales_leads" ("twilio_call_sid");
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; resupply-schema posture,
-- migration 0170). No tenant RLS predicate — this is platform-global data
-- only the service role and platform operators touch.
ALTER TABLE "resupply"."sales_leads" ENABLE ROW LEVEL SECURITY;
