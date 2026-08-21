-- 0510_penn_official_company_name — retire the "PennPaps" storefront DBA for
-- the Penn Home Medical Supply tenant so every name surface reads the
-- company's OFFICIAL name.
--
-- Background. Penn Home Medical Supply historically carried a second,
-- storefront-only brand ("PennPaps") layered on top of its registered name:
--   * `organizations.storefront_name` = 'PennPaps' (seeded by 0346) — the
--     header/hero/footer brand the SPA renders from GET /api/storefront-branding.
--   * `dme_organization.dba_name` = 'PennPaps' (operator-entered at
--     /admin/company-information) — the patient-facing `CompanyInfo.name` used
--     by SMS/voice/email/chatbot copy and PDF headers.
-- The tenant now trades under one name in every one of those places. Two names
-- for one company is a support and compliance hazard: patients saw "PennPaps"
-- in a reminder text and "Penn Home Medical Supply" on the shipped paperwork.
--
-- What changes: the two NAME columns above. Nothing else.
--
-- What deliberately does NOT change — these are addresses, not names, and the
-- tenant keeps them:
--   * `custom_domain` = 'pennpaps.com' (verified; still routes to this tenant)
--   * `from_email` = 'info@pennpaps.com' / `from_name` (0377)
--   * `logo_url` = '/penn/pennpaps-logo.jpeg' (0466) — an asset path
--   * the `RESUPPLY_ASSISTANT_*` app_config names PennBot / PennPilot (0349),
--     which name the assistants, not the company.
--
-- Effect on `CompanyInfo` (artifacts/resupply-api/src/lib/company-info.ts):
-- `name` resolves as `dba_name || legal_name`, so clearing `dba_name` makes
-- `name` === `legalName` === 'Penn Home Medical Supply'. That is the point —
-- one name, resolved from one column, for both storefront and document
-- surfaces. It also switches on `applyCompanyIdentityToText`'s "Penn Paps"
-- two-word TTS needle, which was suppressed only while `name` was 'PennPaps'.
--
-- Targeted + idempotent: each statement matches the exact legacy literal, so
-- re-running is a no-op and an operator's own later edit is never clobbered.
-- On a fresh database `dme_organization` is unseeded (the row is entered in
-- the admin UI), so statement 2 matches zero rows there — correct, not a bug.
--
-- Per ADR 003 — versioned hand-authored migration.

-- 1. Storefront brand → the official company name. 0346 backfilled the
--    historical 'PennPaps' literal here; correct it forward rather than
--    editing that shipped migration.
UPDATE "resupply"."organizations"
SET "storefront_name" = 'Penn Home Medical Supply'
WHERE "slug" = 'penn-home-medical'
  AND "storefront_name" = 'PennPaps';
--> statement-breakpoint

-- 2. Drop the storefront-only DBA so the patient-facing company name falls
--    through to `legal_name`. NULL (not a copy of the legal name) is the
--    honest encoding: this company has no "doing business as" any more, and
--    the admin Company Information form renders the field empty accordingly.
--
--    Scoped by ORG IDENTITY, like statement 1 — `dme_organization` is
--    tenant-scoped (`org_id`, migration 0331/0375) and neither name column
--    is unique, so matching on the name strings alone would also clear the
--    DBA of any other tenant that happened to carry the same pair. Matching
--    the slug is the only predicate that actually means "this tenant".
--
--    The `dba_name` match stays as the idempotence guard: it targets the
--    retired brand specifically, so re-running is a no-op and a DBA the
--    operator sets later is never clobbered. The `legal_name` test is now a
--    SAFETY check rather than an identity one — clearing the DBA must leave
--    a name behind, since `loadFromDb` discards a row with a blank
--    `legal_name` entirely and the tenant would fall back to the env
--    identity. It no longer depends on the exact registered spelling.
UPDATE "resupply"."dme_organization" AS o
SET "dba_name" = NULL
WHERE lower(coalesce(o."dba_name", '')) = 'pennpaps'
  AND coalesce(btrim(o."legal_name"), '') <> ''
  AND EXISTS (
    SELECT 1
    FROM "resupply"."organizations" AS org
    WHERE org."id" = o."org_id"
      AND org."slug" = 'penn-home-medical'
  );
