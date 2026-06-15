-- 0347_org_custom_domain_tls — per-tenant custom-domain TLS provisioning
-- state for the Cloudflare-for-SaaS automation (ADR 021).
--
-- The custom-domain feature (0344_tenant_storefront_branding) tracks
-- OWNERSHIP (`custom_domain_status`: none|pending|verified). Automating
-- the edge TLS binding adds a SECOND, independent lifecycle — the
-- certificate / custom-hostname state on the edge — which must be shown
-- to the tenant distinctly from ownership ("you own it" vs "HTTPS is
-- live"). This migration adds that state plus the feature flag that gates
-- the whole automation path.
--
-- ADDITIVE and inert by default: the new column defaults to 'none', the
-- flag is seeded OFF, and no code reads either until the automation lands
-- behind the flag. The seed tenant's own apex (pennpaps.com) stays 'none'
-- — the platform domain's TLS is handled by the existing Cloudflare edge,
-- not the per-tenant Custom Hostnames API.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain_tls" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "custom_domain_cf_hostname_id" varchar(64);
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  DROP CONSTRAINT IF EXISTS "organizations_custom_domain_tls_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."organizations"
  ADD CONSTRAINT "organizations_custom_domain_tls_enum"
  CHECK ("custom_domain_tls" IN ('none', 'pending', 'active', 'failed'));
--> statement-breakpoint

-- Feature flag gating the Cloudflare-for-SaaS TLS automation. Seeded OFF:
-- the automated path only runs when this is ON *and* the Cloudflare env
-- (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID) is configured. With either
-- absent, domain verify behaves exactly as before (mark verified; manual
-- operator TLS step per docs/runbooks/tenant-custom-domain.md).
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'domains.tls_automation',
  false,
  'Automatically provision + renew TLS for tenant custom domains via Cloudflare for SaaS (Custom Hostnames) when a domain is verified. Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID. Off = manual operator edge binding.',
  'Integrations'
)
ON CONFLICT (key) DO NOTHING;
