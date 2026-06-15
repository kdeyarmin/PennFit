-- CareMetric Breathe brand split: the platform is CareMetric Breathe;
-- Penn Home Medical Supply ("PennPaps") is one tenant operating on it.
-- The two in-app AI assistants now default to the CareMetric platform
-- names ("CareMetric Assistant" / "CareMetric Copilot") so every tenant
-- — including future ones — gets neutral, platform-branded assistants
-- out of the box, and a tenant owner can rename them from System
-- Configuration (RESUPPLY_ASSISTANT_STOREFRONT_NAME /
-- RESUPPLY_ASSISTANT_ADMIN_NAME, applied via the app_config overlay).
--
-- This migration preserves the EXISTING Penn Home Medical Supply
-- deployment's assistant names ("PennBot" / "PennPilot") so the live
-- storefront and admin console are unchanged. It seeds the override
-- ONLY when this database belongs to Penn Home Medical Supply; any
-- other DME's database is left untouched (no row → company-info falls
-- back to the CareMetric defaults). Idempotent: ON CONFLICT DO NOTHING
-- never clobbers a value the tenant owner later set in the UI.

INSERT INTO resupply.app_config (key, value, updated_by_email)
SELECT 'RESUPPLY_ASSISTANT_STOREFRONT_NAME', 'PennBot', 'migration:0347'
WHERE EXISTS (
  SELECT 1
  FROM resupply.dme_organization
  WHERE singleton = true
    AND (
      lower(coalesce(dba_name, '')) = 'pennpaps'
      OR lower(coalesce(legal_name, '')) = 'penn home medical supply'
    )
)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO resupply.app_config (key, value, updated_by_email)
SELECT 'RESUPPLY_ASSISTANT_ADMIN_NAME', 'PennPilot', 'migration:0347'
WHERE EXISTS (
  SELECT 1
  FROM resupply.dme_organization
  WHERE singleton = true
    AND (
      lower(coalesce(dba_name, '')) = 'pennpaps'
      OR lower(coalesce(legal_name, '')) = 'penn home medical supply'
    )
)
ON CONFLICT (key) DO NOTHING;
