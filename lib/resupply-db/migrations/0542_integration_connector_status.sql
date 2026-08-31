-- 0542_integration_connector_status — remember what each therapy-cloud
-- connector last did, per tenant.
--
-- THE GAP
-- -------
-- `/admin/integrations/:source/validate` proves a connection works. It
-- prints a result and forgets it. So the two questions an operator
-- actually has cannot be answered:
--
--   "Has this connector EVER worked here?"
--   "When did it last work, and what broke since?"
--
-- `integrations-status.ts` answers a third, weaker one — "are the
-- credentials present?" — from `availability()`, which reads env vars and
-- never calls the vendor. A connector with a revoked secret, a missing
-- partnership entitlement, or a wrong endpoint path reports exactly the
-- same as a healthy one.
--
-- That matters more here than in most integrations: every endpoint path
-- in the three vendor clients is an unverified placeholder written
-- against published docs, and no tenant has ever had live credentials.
-- Nothing in the product may say "Production Validated" about a connector
-- until a row here says a real call succeeded.
--
-- WHAT THIS STORES
-- ----------------
-- One row per (org, source). Attempted and successful timestamps kept
-- SEPARATE — "last tried at 04:30, last succeeded three weeks ago" is the
-- shape of a connector that has been broken for three weeks, and a single
-- `last_run_at` cannot express it.
--
-- `last_error_category` is the classified vocabulary from
-- lib/resupply-integrations/src/errors.ts, never a vendor message. The
-- distinction it preserves is the point: a 403 (`forbidden` — the account
-- lacks an entitlement) must not read as a 401 (`auth_failed` — the
-- secret is wrong), or an operator rotates a perfectly good credential.
--
-- PHI / SECRETS: no credential, no vendor payload, no patient identifier.
-- Timestamps, counts, an error CATEGORY and a vendor API version string.

CREATE TABLE IF NOT EXISTS "resupply"."integration_connector_status" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "source" text NOT NULL,
  -- The operator-facing verdict. `unvalidated` is the DEFAULT and the
  -- honest starting state: credentials may be present, but nothing has
  -- proved they work.
  "status" text DEFAULT 'unvalidated' NOT NULL,
  "last_validation_attempt_at" timestamp with time zone,
  "last_validation_success_at" timestamp with time zone,
  "last_sync_attempt_at" timestamp with time zone,
  "last_sync_success_at" timestamp with time zone,
  -- Classified category only — see the header.
  "last_error_category" text,
  -- Which validation step failed (configured / authenticated / …).
  "last_error_step" text,
  -- Vendor API version, when the vendor tells us one.
  "vendor_api_version" text,
  -- Sub-resources the vendor did not return on the last successful
  -- fetch. A snapshot missing its compliance summary because that one
  -- endpoint 403'd is NOT a patient with no compliance data, and
  -- reporting them identically is how a half-working connector looks
  -- healthy for months.
  "partial_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  -- Last portal-export reconciliation run for this source.
  "last_reconciliation_at" timestamp with time zone,
  "last_reconciliation_status" text,
  "validated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."integration_connector_status"
    ADD CONSTRAINT "integration_connector_status_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "resupply"."organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resupply"."integration_connector_status"
    ADD CONSTRAINT "integration_connector_status_source_enum"
    CHECK ("source" IN ('resmed_airview', 'philips_care', 'react_health'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- The vocabulary an operator reads. `live_validated` is deliberately the
-- ONLY value that means a real vendor call succeeded here; nothing in the
-- product may claim production validation without it.
DO $$ BEGIN
  ALTER TABLE "resupply"."integration_connector_status"
    ADD CONSTRAINT "integration_connector_status_status_enum"
    CHECK ("status" IN (
      'unvalidated',
      'not_configured',
      'live_validated',
      'degraded',
      'failing',
      'disabled'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- `live_validated` requires a success timestamp. Enforced in the database
-- because two writers reach this table (the validate route and the
-- nightly sync), and "we marked it validated but nothing ever succeeded"
-- is the exact claim this whole table exists to make impossible.
DO $$ BEGIN
  ALTER TABLE "resupply"."integration_connector_status"
    ADD CONSTRAINT "integration_connector_status_validated_needs_success"
    CHECK (
      "status" <> 'live_validated'
      OR "last_validation_success_at" IS NOT NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "integration_connector_status_org_source_idx"
  ON "resupply"."integration_connector_status" ("org_id", "source");
