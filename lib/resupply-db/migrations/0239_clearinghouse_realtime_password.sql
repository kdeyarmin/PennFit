-- 0239_clearinghouse_realtime_password — store the real-time eligibility
-- web-service password on the clearinghouse_credentials row.
--
-- Companion to 0238. By operator request, the real-time password may now
-- be entered in the admin console (Billing → Config → Clearinghouse)
-- instead of only via the OFFICE_ALLY_REALTIME_PASSWORD env var. The DB
-- value takes precedence; the env var remains a fallback (dev/preview).
--
-- NOTE: unlike the SFTP key (a file path) this column holds the password
-- itself. It is held in plaintext and is readable by the service-role
-- client. It is NEVER returned over the admin API (GET exposes only a
-- `realtimePasswordSet` boolean) and never written to logs/audit values.

ALTER TABLE "resupply"."clearinghouse_credentials"
  ADD COLUMN IF NOT EXISTS "realtime_password" text;
