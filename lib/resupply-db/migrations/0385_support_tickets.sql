-- 0385_support_tickets — tenant → platform support ticketing with an
-- AI intake bot.
--
-- Gives every tenant (DME) a way to file a support request to the
-- platform operator (the super-admins), and an AI bot that answers the
-- question on intake from the SAME admin-console knowledge base PennPilot
-- uses. High-confidence questions are answered automatically (ticket →
-- `awaiting_tenant`, `bot_answered = true`); anything the bot can't
-- confidently answer escalates to the platform support queue
-- (`awaiting_platform`) for a human. The bot degrades to a hand-off
-- whenever no LLM provider key is configured, so this never depends on a
-- vendor key being present.
--
-- Two tables, both ORG-SCOPED (a ticket belongs to the tenant that filed
-- it; the org-scoped Supabase facade enforces the `org_id` filter on the
-- tenant-facing routes). The platform routes read across tenants via the
-- `.raw()` escape hatch, exactly like the rest of the /platform surface.
--
-- Lifecycle (`support_tickets.status`):
--   awaiting_tenant   — bot or platform replied; ball is in the tenant's court
--   awaiting_platform — needs a human at the platform (the support queue)
--   resolved          — closed by the tenant or the platform
--   closed            — archived by the platform
-- ('open' is the transient default a row carries for the instant between
--  INSERT and the bot's decision.)
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "subject" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open'
    CHECK ("status" IN (
      'open', 'awaiting_tenant', 'awaiting_platform', 'resolved', 'closed'
    )),
  -- Who filed it (the tenant admin). Free-form email + the auth user id
  -- (no cross-schema FK, matching admin_users.auth_user_id convention).
  "created_by_email" text,
  "created_by_user_id" text,
  -- Did the intake bot auto-answer, and how confident was it (0..1)?
  "bot_answered" boolean NOT NULL DEFAULT false,
  "bot_confidence" numeric,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- Drives the queue ordering (newest activity first).
  "last_activity_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."support_ticket_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id" uuid NOT NULL
    REFERENCES "resupply"."support_tickets"("id") ON DELETE CASCADE,
  -- Denormalised org_id so the org-scoped facade can filter messages
  -- without a join (every resupply table carries org_id).
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "author_role" text NOT NULL
    CHECK ("author_role" IN ('tenant', 'bot', 'platform')),
  "author_email" text,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Per-tenant ticket list (the tenant's own Support page) and the
-- cross-tenant platform queue both sort by recent activity.
CREATE INDEX IF NOT EXISTS "support_tickets_org_status_idx"
  ON "resupply"."support_tickets" ("org_id", "status", "last_activity_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx"
  ON "resupply"."support_tickets" ("status", "last_activity_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_messages_ticket_idx"
  ON "resupply"."support_ticket_messages" ("ticket_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_messages_org_idx"
  ON "resupply"."support_ticket_messages" ("org_id");
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; same posture as the rest of
-- the resupply schema — migration 0170).
ALTER TABLE "resupply"."support_tickets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "resupply"."support_ticket_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Feature flag: gate the tenant-facing Support surface. Seeded ENABLED
-- for EVERY existing tenant (not just the seed org) so the feature is on
-- out of the box; it degrades to a human hand-off when no AI provider key
-- is set. Composite (org_id, key) conflict per migration 0350. New
-- tenants inherit it via tenant:onboard's seed-org copy.
--
-- Shape note: the feature-flags catalog drift guard
-- (feature-flags.catalog.test.ts) scans migrations for the seeded-key
-- tuple (quoted key immediately followed by the enabled boolean) and
-- requires the unquoted `resupply.feature_flags` table reference. The
-- CROSS JOIN fans that one tuple across every org while keeping the shape.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('support.tickets', true, 'Support tickets — tenants file support requests to the platform operator; an AI bot answers from the admin-console knowledge base on intake (Claude / GPT fallback) and escalates anything it cannot confidently answer to a human. Degrades to a hand-off when no AI provider key is set.', 'Voice & AI')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
