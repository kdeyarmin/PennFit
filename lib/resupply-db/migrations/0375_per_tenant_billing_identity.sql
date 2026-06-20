-- 0375_per_tenant_billing_identity — relax the single-tenant billing
-- uniqueness so a SECOND tenant can carry its own DME billing identity and
-- clearinghouse credentials.
--
-- Background. dme_organization was created as a global SINGLETON (one row,
-- enforced by a partial unique index on `singleton = true`, migration 0132)
-- and clearinghouse_credentials was unique on (slug, usage_indicator) — both
-- assumed exactly one DME company. The multi-tenant cutover added an `org_id`
-- to each and backfilled it to the seed tenant (dme_organization in 0331,
-- clearinghouse_credentials in 0341), but the OLD single-tenant unique
-- constraints remained, so a second tenant could not insert its own billing
-- identity. The identity resolver now reads these tables ORG-SCOPED and fails
-- closed for a non-seed tenant without its own rows (so it never bills under
-- the seed NPI / uploads over the seed SFTP). This migration makes it
-- possible to configure that per-tenant identity by re-keying the uniqueness
-- to be per `org_id`.
--
-- Single-tenant impact: NONE. The seed tenant already has exactly one row in
-- each table with org_id = the seed org, which satisfies every new
-- constraint; the dropped constraints only ever allowed one row anyway.
--
-- Idempotent: re-assert the seed backfill (no-op if already set), DROP the old
-- indexes IF EXISTS, CREATE the new ones IF NOT EXISTS.

-- ── dme_organization: singleton → one-row-per-org ──────────────────────
UPDATE "resupply"."dme_organization"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "resupply"."dme_organization_singleton_uq";
--> statement-breakpoint

-- One billing identity per tenant. (Partial index on a non-null org_id so a
-- stray NULL — there are none after the backfill — can never block the index
-- build; NULLs are distinct under a unique index regardless.)
CREATE UNIQUE INDEX IF NOT EXISTS "dme_organization_org_uq"
  ON "resupply"."dme_organization" ("org_id")
  WHERE "org_id" IS NOT NULL;
--> statement-breakpoint

-- ── clearinghouse_credentials: (slug, usage) → (org, slug, usage) ──────
UPDATE "resupply"."clearinghouse_credentials"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "resupply"."clearinghouse_credentials_slug_env_uq";
--> statement-breakpoint

-- Each tenant gets its own (slug, usage_indicator) credential pair — e.g. two
-- tenants can both hold (office_ally, P) for their own Office Ally accounts.
CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_credentials_org_slug_env_uq"
  ON "resupply"."clearinghouse_credentials" ("org_id", "slug", "usage_indicator")
  WHERE "org_id" IS NOT NULL;
