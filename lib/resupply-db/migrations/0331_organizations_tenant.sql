-- 0325_organizations_tenant — multi-tenant FOUNDATION (Phase 0, PR 0.1).
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md.
--
-- PennFit is single-tenant today: one singleton `dme_organization` row
-- carries the operating company's billing identity. The multi-tenant
-- conversion (leasing the platform to other DME companies under the
-- CareMetric AI brand) needs a first-class TENANT that every scoped row
-- will eventually hang off of via `org_id`.
--
-- This migration is the NON-BREAKING first step. It is deliberately
-- ADDITIVE and single-tenant-correct:
--
--   1. Creates `resupply.organizations` — a thin tenant table
--      (id, slug, name, status). This is the new source of TENANT
--      identity. It does NOT absorb `dme_organization`'s billing
--      identity (legal_name, tax_id, NPI, …) — that billing-critical
--      singleton is left completely untouched. We chose the additive
--      "thin parent" shape over renaming/promoting `dme_organization`
--      precisely so this first slice cannot regress billing.
--   2. Seeds tenant #1 (the existing operating company) so all current
--      data has a home the moment later batches add `org_id`.
--   3. Links the existing `dme_organization` singleton to tenant #1 via
--      a nullable `org_id` FK, backfilled in this same migration.
--
-- Nothing reads `org_id` yet — no query filters on it, no behavior
-- changes. The per-domain `org_id` backfills (patients, orders, comms,
-- billing, …) and the org-scoped query wrapper land in subsequent PRs
-- (Phase 0 plan, workstreams A2 + C). RLS policies (workstream D) are a
-- later additive migration; this table inherits the schema-wide RLS
-- posture (enabled, service-role-only) from migrations 0169/0170.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. organizations — the tenant table.
-- ────────────────────────────────────────────────────────────────────
--
-- `slug` is the stable, URL-safe tenant key (used later for host /
-- subdomain routing in Phase 3). `status` gates a tenant without
-- deleting its data ('active' | 'suspended' | 'archived').
CREATE TABLE IF NOT EXISTS "resupply"."organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(63) NOT NULL,
  "name" varchar(200) NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organizations_slug_format"
    CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  CONSTRAINT "organizations_name_chk"
    CHECK (length(btrim("name")) > 0),
  CONSTRAINT "organizations_status_enum"
    CHECK ("status" IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq"
  ON "resupply"."organizations" ("slug");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. Seed tenant #1 — the existing operating company.
-- ────────────────────────────────────────────────────────────────────
--
-- Idempotent on slug. The display name mirrors the legal name on the
-- existing `dme_organization` singleton when present, else a sensible
-- default; either way it is admin-editable later. We do NOT copy any
-- other billing fields — `dme_organization` stays the system of record
-- for billing identity.
INSERT INTO "resupply"."organizations" ("slug", "name", "status")
SELECT
  'penn-home-medical',
  COALESCE(
    (SELECT "legal_name" FROM "resupply"."dme_organization" LIMIT 1),
    'Penn Home Medical Supply'
  ),
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM "resupply"."organizations" WHERE "slug" = 'penn-home-medical'
);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. Link the dme_organization singleton to tenant #1.
-- ────────────────────────────────────────────────────────────────────
--
-- Nullable FK + backfill. Additive: the column defaults NULL, no
-- existing query references it, and the singleton constraint on
-- `dme_organization` is untouched. A later PR may tighten this to
-- NOT NULL once multi-tenant onboarding is live.
ALTER TABLE "resupply"."dme_organization"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint

UPDATE "resupply"."dme_organization"
SET "org_id" = (
  SELECT "id" FROM "resupply"."organizations"
  WHERE "slug" = 'penn-home-medical'
  LIMIT 1
)
WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dme_organization_org_idx"
  ON "resupply"."dme_organization" ("org_id");
