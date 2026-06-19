-- providers — central registry of physicians / NPs who prescribe
-- CPAP therapy for our patients. See lib/resupply-db/src/schema/
-- providers.ts for the full rationale.
--
-- Replaces the free-text jsonb prescriber fields scattered across
-- prescriptions.details and shop_customers.physician_info_json
-- as the system of record. Best-effort backfill of those columns
-- lives in 0073_providers_backfill.sql (separate migration so the
-- schema lands first and the backfill can be retried independently).
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+. Forward-
-- deploy-safe (CREATE TABLE IF NOT EXISTS); environments past this
-- migration get the table, prior environments are unaffected.

CREATE TABLE IF NOT EXISTS "resupply"."providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "npi" varchar(10) NOT NULL,
  "legal_name" text NOT NULL,
  "taxonomy_code" varchar(16),
  "phone_e164" varchar(16),
  "fax_e164" varchar(16),
  "email" text,
  "practice_address" jsonb,
  "practice_name" text,
  "source" text NOT NULL DEFAULT 'csr_entry',
  "verified_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "providers_source_enum"
    CHECK ("source" IN ('nppes', 'csr_entry', 'backfill')),
  CONSTRAINT "providers_npi_format"
    CHECK ("npi" ~ '^[0-9]{10}$')
);

-- NPI is the global unique identifier. Lookups on every Rx create
-- and PA submission hit this index.
CREATE UNIQUE INDEX IF NOT EXISTS "providers_npi_unique"
  ON "resupply"."providers" ("npi");

-- Admin search-by-name in the lookup bar.
CREATE INDEX IF NOT EXISTS "providers_legal_name_idx"
  ON "resupply"."providers" ("legal_name");
