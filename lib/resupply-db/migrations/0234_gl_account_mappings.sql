-- 0234_gl_account_mappings — configurable GL account names for the
-- QuickBooks IIF export (owner #O3).
--
-- The QuickBooks export hardcoded the deposit/revenue/refund/patient-pay
-- account names, so a bookkeeper had to manually re-map every line on
-- import. This tiny config table lets the owner set the account names
-- once; the export reads them (falling back to the historical defaults
-- when a key is unset, so behaviour is unchanged until configured).
--
-- Plain table (no RLS), service-role only. No PHI — account-name strings.
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."gl_account_mappings" (
  "mapping_key" text PRIMARY KEY,
  "account_name" text NOT NULL,
  "updated_by_email" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gl_account_mappings_key_chk" CHECK (
    "mapping_key" IN ('deposit', 'revenue', 'refund', 'patient_pay')
  ),
  CONSTRAINT "gl_account_mappings_name_chk" CHECK (
    length(btrim("account_name")) > 0
  )
);
