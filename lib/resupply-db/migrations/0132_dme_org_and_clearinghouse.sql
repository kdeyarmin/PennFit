-- 0132_dme_org_and_clearinghouse — move DME identity and clearinghouse
-- credentials out of env vars and into editable rows, plus add the
-- inbound-polling audit trail that lets the worker pull 999 / 277CA /
-- 835 files from Office Ally without re-processing duplicates.
--
-- Why
-- ---
-- Today the 837P builder reads our organization identity from a swarm
-- of OFFICE_ALLY_BILLING_* env vars (NPI, tax id, legal name, address,
-- phone, ETIN). That:
--
--   1. Requires a deploy every time the org changes (move offices,
--      add a Tax ID, new PTAN), which is hostile to the billing team.
--   2. Provides no audit trail for "what NPI did we bill with on
--      2026-03-01?" — env-var history is invisible in production.
--   3. Cannot represent multi-clearinghouse routing (a future
--      Change Healthcare or Availity migration).
--   4. Cannot hold accreditation / surety bond / liability data
--      that DMEPOS surveyors require but that today lives in a
--      Google Doc nobody updates.
--
-- This migration creates:
--
--   1. dme_organization — singleton row carrying every piece of
--      organizational data the 837P builder, HCFA PDF generator,
--      ABN / SWO forms, and accreditation binder all need.
--   2. dme_organization_contacts — named contact roster (billing
--      manager, compliance officer, authorized signer for SWO /
--      ABN, etc).
--   3. clearinghouse_credentials — one row per clearinghouse (Office
--      Ally today; Change / Availity later). Holds the SFTP config,
--      ETIN, usage indicator, contact info. Secrets remain on disk
--      (the private key file referenced by `private_key_path`) and
--      this table only references their paths — we deliberately do
--      NOT store key material in the DB.
--   4. clearinghouse_inbound_files — audit trail of inbound files
--      the poller has pulled, keyed by remote path + SHA-256, so a
--      re-run of the polling worker is idempotent and a redelivery
--      of the same 999 / 277CA / 835 is a no-op.
--
-- The new tables sit alongside the env-based config; the office-ally
-- adapter reads from the DB first and falls back to env when the row
-- is absent. That preserves dev / preview environments.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. dme_organization — singleton row of organizational identity.
-- ────────────────────────────────────────────────────────────────────
--
-- Uniqueness: there is exactly ONE row per deployment. Enforced by
-- the `singleton` boolean column with a partial unique index — the
-- application inserts the row with singleton=true, and the
-- unique-true constraint prevents a second row from sneaking in. We
-- intentionally avoid a smallint=0 constraint so a multi-tenant
-- evolution can drop the singleton flag in a follow-up.
CREATE TABLE IF NOT EXISTS "resupply"."dme_organization" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "singleton" boolean NOT NULL DEFAULT true,
  -- ──── Legal identity ────
  "legal_name" varchar(200) NOT NULL,
  "dba_name" varchar(200),
  -- Federal Tax ID (EIN), 9 digits no dashes.
  "tax_id" varchar(9) NOT NULL,
  -- Type-2 organizational NPI.
  "organizational_npi" varchar(10) NOT NULL,
  -- CMS DMEPOS provider taxonomy. Default = 332B00000X (DMEPOS).
  "taxonomy_code" varchar(10) NOT NULL DEFAULT '332B00000X',
  -- Medicare DMEPOS supplier number (PTAN). Required to bill Medicare.
  "medicare_ptan" varchar(20),
  -- ──── Physical / billing addresses ────
  "physical_address_line1" varchar(120) NOT NULL,
  "physical_address_line2" varchar(120),
  "physical_city" varchar(80) NOT NULL,
  "physical_state" varchar(2) NOT NULL,
  "physical_zip" varchar(10) NOT NULL,
  -- Mailing address (where the office receives paper mail). Defaults to physical.
  "mailing_address_line1" varchar(120),
  "mailing_address_line2" varchar(120),
  "mailing_city" varchar(80),
  "mailing_state" varchar(2),
  "mailing_zip" varchar(10),
  -- Pay-to address (used in 837P 2010AC pay-to-provider and on ERA
  -- payment vouchers). Defaults to physical when null.
  "pay_to_address_line1" varchar(120),
  "pay_to_address_line2" varchar(120),
  "pay_to_city" varchar(80),
  "pay_to_state" varchar(2),
  "pay_to_zip" varchar(10),
  -- ──── Contact ────
  "phone_e164" varchar(20) NOT NULL,
  "fax_e164" varchar(20),
  "billing_email" varchar(180) NOT NULL,
  "general_email" varchar(180),
  "website_url" varchar(240),
  -- ──── Accreditation ────
  "accreditation_body" text,
  "accreditation_number" varchar(60),
  "accreditation_expires_on" date,
  -- ──── State licensure ────
  "state_license_number" varchar(60),
  "state_license_state" varchar(2),
  "state_license_expires_on" date,
  -- ──── Liability insurance ────
  "liability_carrier" varchar(160),
  "liability_policy_number" varchar(60),
  "liability_expires_on" date,
  -- ──── DMEPOS surety bond ────
  "surety_bond_carrier" varchar(160),
  "surety_bond_amount_cents" bigint,
  "surety_bond_expires_on" date,
  -- ──── Authorized signers ────
  -- Default authorized signer for SWO / ABN / appeal letters. The
  -- name + title are printed under the signature line; the actual
  -- signature image (if any) lives in object storage.
  "authorized_signer_name" varchar(160),
  "authorized_signer_title" varchar(120),
  "authorized_signer_signature_object_key" text,
  -- ──── Free-form / bookkeeping ────
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dme_organization_tax_id_format"
    CHECK ("tax_id" ~ '^\d{9}$'),
  CONSTRAINT "dme_organization_npi_format"
    CHECK ("organizational_npi" ~ '^\d{10}$'),
  CONSTRAINT "dme_organization_state_format"
    CHECK ("physical_state" ~ '^[A-Z]{2}$'),
  CONSTRAINT "dme_organization_zip_format"
    CHECK ("physical_zip" ~ '^\d{5}(-?\d{4})?$'),
  CONSTRAINT "dme_organization_accreditation_body_enum"
    CHECK (
      "accreditation_body" IS NULL
      OR "accreditation_body" IN ('achc', 'boc', 'tjc', 'cap', 'other')
    ),
  CONSTRAINT "dme_organization_surety_bond_nonneg"
    CHECK (
      "surety_bond_amount_cents" IS NULL
      OR "surety_bond_amount_cents" >= 0
    )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dme_organization_singleton_uq"
  ON "resupply"."dme_organization" ("singleton")
  WHERE "singleton" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. dme_organization_contacts — named contact roster.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."dme_organization_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "resupply"."dme_organization"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "name" varchar(160) NOT NULL,
  "title" varchar(120),
  "email" varchar(180),
  "phone_e164" varchar(20),
  "is_primary" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dme_organization_contacts_role_enum"
    CHECK ("role" IN (
      'billing_manager',
      'compliance_officer',
      'authorized_signer',
      'medical_director',
      'office_manager',
      'edi_contact',
      'credentialing',
      'patient_advocate',
      'other'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dme_organization_contacts_org_idx"
  ON "resupply"."dme_organization_contacts" ("organization_id", "role");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. clearinghouse_credentials — per-clearinghouse SFTP + ETIN config.
-- ────────────────────────────────────────────────────────────────────
--
-- We store paths to credential files (private key, known_hosts),
-- never the credential material itself. The application's
-- existing secrets posture (filesystem-mounted keys, env vars for
-- API tokens) is preserved; this table just provides a routing /
-- lookup surface.
--
-- One row per (slug, environment) so production + sandbox can
-- coexist; the active row for a given clearinghouse is the one
-- with is_active=true and matching `usage_indicator`.
CREATE TABLE IF NOT EXISTS "resupply"."clearinghouse_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(40) NOT NULL,
  "display_name" varchar(160) NOT NULL,
  -- P (production) or T (test/sandbox). Drives the 837P usage
  -- indicator AND lets us route traffic to the right account.
  "usage_indicator" text NOT NULL DEFAULT 'T',
  -- ──── SFTP transport ────
  "sftp_host" varchar(160) NOT NULL,
  "sftp_port" smallint NOT NULL DEFAULT 22,
  "sftp_username" varchar(120) NOT NULL,
  -- Path to the SSH private key file on the application server.
  -- The file should be mode 0600. We never read the key bytes here.
  "private_key_path" text NOT NULL,
  -- Path to a known_hosts file pinning the clearinghouse host key.
  "known_hosts_path" text NOT NULL,
  "remote_inbox_dir" varchar(120) NOT NULL DEFAULT 'inbound',
  -- The outbound directory the clearinghouse drops our acks + ERAs
  -- into. For Office Ally this is typically `outbound`.
  "remote_outbound_dir" varchar(120) NOT NULL DEFAULT 'outbound',
  "remote_archive_dir" varchar(120),
  -- ──── Submitter identity ────
  -- ETIN / submitter id assigned by the clearinghouse.
  "etin" varchar(40) NOT NULL,
  "submitter_organization_name" varchar(200),
  -- Contact printed on the 1000A PER segment.
  "contact_name" varchar(120),
  "contact_phone_e164" varchar(20),
  -- ──── Operational state ────
  "is_active" boolean NOT NULL DEFAULT true,
  -- When set, the polling worker uses this as the upper bound for
  -- "we processed everything up to T" so it never re-walks the
  -- entire remote inbox.
  "last_polled_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "clearinghouse_credentials_slug_format"
    CHECK ("slug" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "clearinghouse_credentials_usage_indicator_enum"
    CHECK ("usage_indicator" IN ('P', 'T')),
  CONSTRAINT "clearinghouse_credentials_port_range"
    CHECK ("sftp_port" > 0 AND "sftp_port" <= 32767)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_credentials_slug_env_uq"
  ON "resupply"."clearinghouse_credentials" ("slug", "usage_indicator");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clearinghouse_credentials_active_idx"
  ON "resupply"."clearinghouse_credentials" ("is_active")
  WHERE "is_active" = true;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. clearinghouse_inbound_files — audit trail of polled files.
-- ────────────────────────────────────────────────────────────────────
--
-- One row per inbound file the poller pulls. Keyed by file_sha256
-- so a redelivery is a no-op (the same 999 / 277CA / 835 with the
-- same byte content is processed exactly once).
--
-- `dispatch_status` tracks the downstream processing: a 999 lands
-- here as 'parsed', then 'dispatched' once the office_ally_submissions
-- row is updated. An 835 lands as 'parsed' then 'dispatched' once the
-- era_files row is inserted and the reconciler runs.
CREATE TABLE IF NOT EXISTS "resupply"."clearinghouse_inbound_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "clearinghouse_id" uuid NOT NULL
    REFERENCES "resupply"."clearinghouse_credentials"("id") ON DELETE CASCADE,
  "remote_path" text NOT NULL,
  "file_name" varchar(200) NOT NULL,
  "file_sha256" varchar(64) NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "file_kind" text NOT NULL,
  -- Free-form parser summary (counts, control numbers) so the admin
  -- UI can render "what's in this file" without re-downloading.
  "parse_summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "dispatch_status" text NOT NULL DEFAULT 'pending',
  -- FK to the era_files / office_ally_submissions row this inbound
  -- file was applied to. Always SET NULL on delete so the parent
  -- can be retention-swept independently.
  "applied_to_era_file_id" uuid
    REFERENCES "resupply"."era_files"("id") ON DELETE SET NULL,
  "applied_to_submission_id" uuid
    REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL,
  "error_message" text,
  "downloaded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "dispatched_at" timestamp with time zone,
  CONSTRAINT "clearinghouse_inbound_files_kind_enum"
    CHECK ("file_kind" IN ('999', '277ca', '835', 'unknown')),
  CONSTRAINT "clearinghouse_inbound_files_dispatch_status_enum"
    CHECK ("dispatch_status" IN (
      'pending', 'parsed', 'dispatched', 'dispatch_failed', 'skipped'
    ))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_inbound_files_sha_uq"
  ON "resupply"."clearinghouse_inbound_files" ("clearinghouse_id", "file_sha256");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clearinghouse_inbound_files_downloaded_idx"
  ON "resupply"."clearinghouse_inbound_files" ("clearinghouse_id", "downloaded_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "clearinghouse_inbound_files_pending_idx"
  ON "resupply"."clearinghouse_inbound_files" ("dispatch_status", "downloaded_at")
  WHERE "dispatch_status" IN ('pending', 'parsed', 'dispatch_failed');
