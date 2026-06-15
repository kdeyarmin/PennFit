-- 0346_tenant_storefront_branding — per-tenant storefront identity +
-- custom-domain wiring (multi-tenant Phase 3, the first customer-facing
-- slice on top of the Phase 0 foundation).
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md — the
-- `organizations.slug` was reserved there "for host / subdomain routing
-- in Phase 3", and per-tenant branding was the explicit follow-on. This
-- migration adds the columns that let each tenant:
--
--   1. Show their OWN storefront name, tagline, and logo on the public
--      site (instead of the hardcoded PennPaps brand).
--   2. Point their OWN domain (e.g. shop.acme-dme.com) at the platform
--      and have requests on that host resolve to their storefront.
--
-- ADDITIVE and single-tenant-correct. Every column is nullable (or has a
-- safe default) and no existing query references them, so this changes no
-- behavior until the branding resolver + admin UI (separate app code in
-- this same PR) read them. The seed tenant (#1) is backfilled with the
-- historical PennPaps storefront identity so the live site renders
-- byte-identically until an admin edits it.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. Storefront branding columns.
-- ────────────────────────────────────────────────────────────────────
--
-- `organizations.name` already holds the legal/display name; these add
-- the customer-facing STOREFRONT identity layered on top of it:
--   * storefront_name — the short brand shown in the header / hero
--     (e.g. "PennPaps"). Falls back to `name` when blank.
--   * tagline         — one-line storefront strapline.
--   * logo_url        — public URL of the tenant's uploaded logo. Null
--     keeps the SPA's bundled default logo.
--   * logo_object_path — the object key in the public storage bucket,
--     kept so a re-upload can delete the prior file. Not customer-facing.
ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "storefront_name" varchar(120),
  ADD COLUMN IF NOT EXISTS "tagline" varchar(200),
  ADD COLUMN IF NOT EXISTS "logo_url" text,
  ADD COLUMN IF NOT EXISTS "logo_object_path" text;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. Custom-domain columns.
-- ────────────────────────────────────────────────────────────────────
--
-- A tenant binds ONE custom domain. The lifecycle:
--   'none'     — no domain configured (default).
--   'pending'  — domain entered; a DNS TXT verification record is
--                published for the tenant to add; not yet proven.
--   'verified' — the TXT record was found at verification time; requests
--                on this host resolve to this tenant and the host joins
--                the CORS allowlist. (TLS/edge provisioning in
--                Railway/Cloudflare remains an operator step — see
--                docs/runbooks/tenant-custom-domain.md.)
--
-- `custom_domain` is stored already-normalized (lowercased, no port, no
-- scheme) by the app layer. The partial UNIQUE index guarantees two
-- tenants can't claim the same host.
ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain" varchar(255),
  ADD COLUMN IF NOT EXISTS "custom_domain_status" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "custom_domain_token" varchar(64),
  ADD COLUMN IF NOT EXISTS "custom_domain_verified_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  DROP CONSTRAINT IF EXISTS "organizations_custom_domain_status_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  ADD CONSTRAINT "organizations_custom_domain_status_enum"
  CHECK ("custom_domain_status" IN ('none', 'pending', 'verified'));
--> statement-breakpoint

-- A custom domain is a lowercase DNS hostname when set (defense in depth:
-- the app normalizes before writing, but a malformed direct write must
-- not poison host-based routing).
ALTER TABLE "resupply"."organizations"
  DROP CONSTRAINT IF EXISTS "organizations_custom_domain_format";
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  ADD CONSTRAINT "organizations_custom_domain_format"
  CHECK (
    "custom_domain" IS NULL
    OR "custom_domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_custom_domain_uq"
  ON "resupply"."organizations" ("custom_domain")
  WHERE "custom_domain" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. Backfill the seed tenant with the historical PennPaps storefront
--    identity so the live site is unchanged until an admin edits it.
-- ────────────────────────────────────────────────────────────────────
--
-- Only sets fields that are still NULL (idempotent / non-destructive).
-- logo_url stays NULL on purpose — the SPA's bundled PennPaps logo is the
-- default when no per-tenant logo is uploaded, so the seed tenant keeps
-- rendering exactly the asset it ships today.
UPDATE "resupply"."organizations"
SET
  "storefront_name" = COALESCE("storefront_name", 'PennPaps'),
  "tagline" = COALESCE(
    "tagline",
    'Your CPAP, made simple. Fit. Shop. Resupply.'
  )
WHERE "slug" = 'penn-home-medical';
