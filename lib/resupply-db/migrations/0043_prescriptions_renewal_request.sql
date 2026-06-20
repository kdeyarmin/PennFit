-- prescriptions.renewal_requested_at — timestamp of the most recent
-- "your Rx is expiring; please contact your prescriber" email we
-- sent to the patient (Phase B.2 / feature #7).
--
-- Read by /admin/prescriptions/send-renewal-due to skip rows we
-- already nudged in the current renewal window. Null until we send;
-- partial index supports the dispatcher's "find rows expiring soon
-- that we haven't nudged yet" scan.
--
-- We don't auto-clear this column on prescription renewal — if the
-- physician issues a NEW prescription, that's a new row (we keep
-- history per ./prescriptions.ts policy). The timestamp here is
-- attached to the EXPIRING row only.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "renewal_requested_at" timestamp with time zone;

-- Dispatcher-eligibility index: active rows that have a valid_until
-- date and haven't been nudged. Partial keeps it tiny.
CREATE INDEX IF NOT EXISTS "prescriptions_renewal_eligible_idx"
  ON "resupply"."prescriptions" ("valid_until")
  WHERE "status" = 'active'
    AND "valid_until" IS NOT NULL
    AND "renewal_requested_at" IS NULL;
