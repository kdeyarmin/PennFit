-- 0466_penn_storefront_logo.sql
--
-- Point the seed tenant (Penn Home Medical Supply / storefront "PennPaps")
-- at its own logo asset.
--
-- Context: migration 0346 deliberately left the Penn tenant's
-- organizations.logo_url NULL because the SPA's *bundled* default logo was
-- the PennPaps image — so a NULL logo_url still rendered Penn's logo. The
-- client compile-time default has since moved to the CareMetric **platform**
-- identity (so a brand-new / unconfigured tenant no longer flashes the Penn
-- brand), and the bundled logo fallback is now the CareMetric logo. The Penn
-- logo is now served as a static public asset at /penn/pennpaps-logo.jpeg,
-- so set Penn's logo_url to it. The host-resolved /api/storefront-branding
-- then returns Penn's own logo on pennpaps.com and the storefront renders it
-- exactly as before.
--
-- Idempotent / non-destructive: only fills logo_url when still NULL, so an
-- admin-uploaded logo is never overwritten (and an already-set row is not
-- needlessly re-written).
UPDATE "resupply"."organizations"
SET "logo_url" = '/penn/pennpaps-logo.jpeg'
WHERE "slug" = 'penn-home-medical'
  AND "logo_url" IS NULL;
