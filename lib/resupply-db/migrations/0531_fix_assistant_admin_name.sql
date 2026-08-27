-- Correct a mis-set RESUPPLY_ASSISTANT_ADMIN_NAME on the seed tenant.
-- Migration 0349 seeds PennPilot for the admin console assistant; some
-- deployments ended up with PennBot in both keys (storefront + admin).
-- The company-info endpoint reads these keys verbatim, so a wrong value
-- makes the SPA label the admin copilot as PennBot.
--
-- Idempotent: only touches rows where the admin key is literally PennBot.

UPDATE resupply.app_config
SET
  value = 'PennPilot',
  updated_by_email = 'migration:0531'
WHERE key = 'RESUPPLY_ASSISTANT_ADMIN_NAME'
  AND value = 'PennBot';
