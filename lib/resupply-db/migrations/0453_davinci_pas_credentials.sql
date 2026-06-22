-- 0453_davinci_pas_credentials — move the Da Vinci PAS per-payer Bearer
-- token out of process env (DAVINCI_PAS_TOKEN_<PAYER_SLUG>) and into an
-- editable, org-scoped credential row.
--
-- Why a NEW table (and not clearinghouse_credentials)
-- ---------------------------------------------------
-- The PAS submit core (artifacts/resupply-api/src/lib/billing/
-- submit-prior-auth.ts) currently reads the access token from
-- `process.env["DAVINCI_PAS_TOKEN_" + payerProfile.slug.toUpperCase()]`,
-- i.e. ONE Bearer token PER PAYER. clearinghouse_credentials does not fit
-- this shape:
--
--   * It is keyed `(org_id, slug, usage_indicator)` where `slug` is a
--     CLEARINGHOUSE (office_ally, change, availity), not a payer. A single
--     row could only hold one token, but PAS needs one per payer.
--   * Its row demands NOT NULL SFTP transport columns (sftp_host,
--     sftp_username, private_key_path, known_hosts_path, etin) plus an
--     `is_active=true` filter that the Office Ally identity resolver reads.
--     Squatting DaVinci tokens on empty-string SFTP rows would pollute that
--     resolver's queries.
--
-- So this table is keyed the way the token is actually keyed: per
-- (org_id, payer_slug). It mirrors the realtime_password storage posture
-- on clearinghouse_credentials (migration 0239): the secret is held as
-- plaintext text readable only by the service-role client, is NEVER
-- returned over the admin API (a `*Set` boolean instead), and is NEVER
-- written to logs/audit. No column-level encryption (repo hard rule —
-- migration 0025 stripped pgcrypto).
--
-- ADDITIVE / idempotent. The DAVINCI_PAS_TOKEN_<SLUG> env var remains the
-- fallback when no row exists (dev/preview + current single-tenant deploy),
-- so nothing breaks for the existing deployment — see
-- resolveDavinciPasToken() in submit-prior-auth's resolver.

CREATE TABLE IF NOT EXISTS "resupply"."davinci_pas_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Tenant owner. NULL is tolerated only for legacy/seed rows the same way
  -- the rest of the billing tables tolerate it (org_id backfilled in the
  -- 0335/0341 series); new rows always carry it.
  "org_id" uuid REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  -- The payer's Da Vinci PAS slug — the SAME identifier that today forms
  -- DAVINCI_PAS_TOKEN_<SLUG> (payer_profiles.slug). Lower-snake to match
  -- the env-var-deriving uppercase round-trip.
  "payer_slug" varchar(64) NOT NULL,
  -- The Bearer access token forwarded in the PAS POST's Authorization
  -- header. Plaintext (no column encryption — repo hard rule); never
  -- returned over the API, never logged.
  "access_token" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "davinci_pas_credentials_payer_slug_format"
    CHECK ("payer_slug" ~ '^[a-z0-9_]+$')
);
--> statement-breakpoint

-- One active token per (tenant, payer). Two tenants can each hold their own
-- token for the same payer; a single tenant has at most one per payer.
CREATE UNIQUE INDEX IF NOT EXISTS "davinci_pas_credentials_org_payer_uq"
  ON "resupply"."davinci_pas_credentials" ("org_id", "payer_slug");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "davinci_pas_credentials_active_idx"
  ON "resupply"."davinci_pas_credentials" ("org_id", "payer_slug")
  WHERE "is_active" = true;
