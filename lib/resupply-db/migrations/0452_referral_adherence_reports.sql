-- 0452_referral_adherence_reports — idempotency ledger for the automated
-- 90-day adherence-report disclosure to a patient's referring provider
-- (Referral CRM Phase 3 / Provider RTM Phase 3; gated by the
-- referrals.adherence_report flag seeded in 0451).
--
-- WHAT
--   One row per (patient, referring provider, window) report the worker
--   sends. Its job is IDEMPOTENCY: the unique index on
--   (org_id, patient_id, provider_id, window_days) guarantees a patient's
--   90-day report is delivered to a given provider at most once, even
--   across worker retries / overlapping ticks. `status` records whether the
--   send succeeded ('sent') or failed ('failed'); a failed row still
--   occupies the unique slot, so the worker does not infinitely re-fax a
--   provider whose number bounces — operators re-drive failures explicitly
--   (a follow-up admin UI).
--
-- PHI POSTURE
--   This table holds NO therapy text and NO patient identity beyond the
--   patient_id FK — only ids, the channel, the status, and the vendor
--   reference. The disclosed document (the adherence attestation PDF) is
--   never stored here; it is re-rendered on demand. Org-scoped: every row
--   carries org_id so the Supabase facade filters/tags it without a join.
--
-- Tenant-scoped (each DME discloses to its own patients' providers).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."referral_adherence_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Denormalised org_id so the org-scoped Supabase facade can filter and
  -- tag rows without a join (every resupply table carries org_id).
  "org_id" uuid NOT NULL
    REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  -- The patient whose adherence was disclosed. CASCADE: deleting the
  -- patient removes their send history.
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- The referring provider the report was sent to (providers registry,
  -- migration 0071). SET NULL on provider delete so the send record
  -- survives a provider deactivation — the disclosure still happened.
  "provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  -- The therapy window the report covers. 90 for the first slice; kept as a
  -- column so a future 30-day cadence is a new window value, not a new
  -- table.
  "window_days" integer NOT NULL DEFAULT 90,
  -- How the report was delivered.
  "channel" text NOT NULL CHECK ("channel" IN ('fax', 'email')),
  -- Outcome of the send. 'failed' rows still occupy the unique slot so the
  -- worker does not re-send on every tick.
  "status" text NOT NULL CHECK ("status" IN ('sent', 'failed')),
  -- Vendor reference (Telnyx fax id / SendGrid message id) when we have it.
  "vendor_ref" text,
  -- When the send was attempted/recorded.
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Idempotency: a patient's report for a given window is sent to a given
-- provider at most once. provider_id is part of the key (a NULL is allowed
-- by a unique index in Postgres, but provider_id is always set on insert by
-- the worker, which only runs for patients WITH a referring provider).
CREATE UNIQUE INDEX IF NOT EXISTS "referral_adherence_reports_unique_idx"
  ON "resupply"."referral_adherence_reports"
  ("org_id", "patient_id", "provider_id", "window_days");
--> statement-breakpoint

-- Org-scoped read index for the (future) admin review surface.
CREATE INDEX IF NOT EXISTS "referral_adherence_reports_org_idx"
  ON "resupply"."referral_adherence_reports" ("org_id", "created_at" DESC);
--> statement-breakpoint

-- Defense-in-depth RLS (mirrors product_ship_specs 0406 / refill paths).
-- service_role (the runtime + worker path) bypasses it; the per-tenant
-- policy is the backstop for the anon/authenticated Data-API roles.
ALTER TABLE "resupply"."referral_adherence_reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."referral_adherence_reports";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."referral_adherence_reports"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT ON "resupply"."referral_adherence_reports" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON "resupply"."referral_adherence_reports" TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "resupply"."referral_adherence_reports" TO service_role;
  END IF;
END
$$;
