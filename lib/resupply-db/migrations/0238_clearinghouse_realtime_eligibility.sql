-- 0238_clearinghouse_realtime_eligibility — DB-configurable real-time
-- eligibility (270/271) connection on clearinghouse_credentials.
--
-- The real-time eligibility transport
-- (lib/resupply-integrations-office-ally/src/transport/realtime.ts) POSTs
-- a 270 to Office Ally's HTTPS service and parses the 271 inline (seconds)
-- instead of submitting over SFTP and waiting for the inbound poll
-- (minutes). These columns let the admin console drive the NON-SECRET
-- real-time config — endpoint, username, CORE sender/receiver ids,
-- timeout, on/off — the same way it drives the SFTP connection.
--
-- This migration adds only the NON-SECRET fields. The real-time password
-- lands in a follow-up (0239_clearinghouse_realtime_password.sql) as a
-- write-only column, with OFFICE_ALLY_REALTIME_PASSWORD as the env
-- fallback for anyone who'd rather keep the secret out of the DB.

ALTER TABLE "resupply"."clearinghouse_credentials"
  ADD COLUMN IF NOT EXISTS "realtime_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "realtime_url" text,
  ADD COLUMN IF NOT EXISTS "realtime_username" text,
  ADD COLUMN IF NOT EXISTS "realtime_sender_id" text,
  ADD COLUMN IF NOT EXISTS "realtime_receiver_id" text,
  ADD COLUMN IF NOT EXISTS "realtime_timeout_ms" integer;
