-- 0410_clearinghouse_insurance_discovery — DB-configurable insurance
-- discovery endpoint on clearinghouse_credentials.
--
-- Insurance discovery (lib/resupply-integrations-office-ally/src/transport/
-- discovery.ts) POSTs patient demographics to Office Ally's EDI REST
-- insurance-discovery service and gets back the list of coverages it
-- matched. It is a SEPARATE endpoint from real-time eligibility (the
-- "search every payer for this person" service vs. "is this one coverage
-- active") but uses the SAME issued EDI API account — so it reuses the
-- real-time Authorization key (realtime_password / OFFICE_ALLY_REALTIME_*)
-- and only needs its own endpoint URL + on/off toggle here.
--
-- ADDITIVE / idempotent. Non-secret fields only (the key is shared with the
-- real-time connection). OFFICE_ALLY_DISCOVERY_URL is the env fallback when
-- no row drives it (dev/preview).

ALTER TABLE "resupply"."clearinghouse_credentials"
  ADD COLUMN IF NOT EXISTS "discovery_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "discovery_url" text;
