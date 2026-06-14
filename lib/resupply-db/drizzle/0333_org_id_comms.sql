-- 0327_org_id_comms — multi-tenant org_id backfill, batch 2 of N
-- (communications). Phase 0, plan workstream A2.
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md and the
-- batch-1 migration 0326 for the rationale. Identical shape: NULLABLE
-- org_id + backfill to the seed tenant (slug 'penn-home-medical') + FK
-- + per-table index. Additive and single-tenant-correct — nothing reads
-- or filters on org_id yet, and no existing INSERT is broken because the
-- column is nullable. NOT NULL tightening + scoped-wrapper cutover land
-- in this domain's cutover PR.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── conversations ───────────────────────────────────────────────────
ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."conversations"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_idx"
  ON "resupply"."conversations" ("org_id");
--> statement-breakpoint

-- ── messages ────────────────────────────────────────────────────────
ALTER TABLE "resupply"."messages"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."messages"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_org_idx"
  ON "resupply"."messages" ("org_id");
--> statement-breakpoint

-- ── message_attachments ─────────────────────────────────────────────
ALTER TABLE "resupply"."message_attachments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."message_attachments"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_attachments_org_idx"
  ON "resupply"."message_attachments" ("org_id");
--> statement-breakpoint

-- ── message_templates ───────────────────────────────────────────────
ALTER TABLE "resupply"."message_templates"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."message_templates"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_templates_org_idx"
  ON "resupply"."message_templates" ("org_id");
--> statement-breakpoint

-- ── alert_definitions ───────────────────────────────────────────────
ALTER TABLE "resupply"."alert_definitions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."alert_definitions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_definitions_org_idx"
  ON "resupply"."alert_definitions" ("org_id");
--> statement-breakpoint

-- ── alert_messages ──────────────────────────────────────────────────
ALTER TABLE "resupply"."alert_messages"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."alert_messages"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_messages_org_idx"
  ON "resupply"."alert_messages" ("org_id");
--> statement-breakpoint

-- ── csr_macros ──────────────────────────────────────────────────────
ALTER TABLE "resupply"."csr_macros"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."csr_macros"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csr_macros_org_idx"
  ON "resupply"."csr_macros" ("org_id");
