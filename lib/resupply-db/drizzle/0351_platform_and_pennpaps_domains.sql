-- 0351_platform_and_pennpaps_domains — split the platform homepage from
-- the Penn Home Medical Supply tenant storefront.
--
-- CareMetric Breathe now uses cmbreathe.com as the platform/home domain.
-- PennPaps (pennpaps.com) remains the Penn Home Medical Supply tenant's
-- storefront and should route by the normal verified custom-domain path.
--
-- ADDITIVE / idempotent: this only stamps the seed tenant's custom-domain
-- fields when they are blank or already set to pennpaps.com. It does not
-- overwrite an operator-selected different custom domain, and it leaves
-- custom_domain_tls unchanged because that column tracks Cloudflare-for-SaaS
-- automation state, not manually bound Cloudflare/Railway TLS.

UPDATE "resupply"."organizations"
SET
  "custom_domain" = 'pennpaps.com',
  "custom_domain_status" = 'verified',
  "custom_domain_token" = NULL,
  "custom_domain_verified_at" = COALESCE("custom_domain_verified_at", NOW())
WHERE "slug" = 'penn-home-medical'
  AND ("custom_domain" IS NULL OR "custom_domain" = 'pennpaps.com');
