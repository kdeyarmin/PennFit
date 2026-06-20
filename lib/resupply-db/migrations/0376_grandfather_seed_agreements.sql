-- 0376_grandfather_seed_agreements — record the seed (operator) tenant's
-- acceptance of the current platform agreements so deploying the G16 gate
-- (migration 0366 + requireAdmin agreements check) does NOT lock the existing
-- admin out of /admin.
--
-- Background. The agreements gate blocks every admin route for any org that
-- hasn't accepted each REQUIRED_AGREEMENTS (type, version) — `baa` and
-- `platform_terms` at their CURRENT versions (lib/agreements/index.ts).
-- Migration 0366 only created the table; nothing seeded an acceptance for the
-- pre-existing single-tenant deployment, so on deploy the live operator admin
-- would be 403'd out of every admin page until they re-sign in the UI.
--
-- This grandfathers ONLY the seed org (the operator's own company,
-- slug 'penn-home-medical') at the versions current as of this migration.
-- Genuinely NEW tenants are unaffected: they carry their own org_id and must
-- still sign via the onboarding UI. The gate stays version-aware — if an
-- agreement's text is later revised the version bumps in code and even the
-- seed org is correctly re-prompted (this seed only covers today's versions).
--
-- VERSIONS BELOW MUST MATCH `REQUIRED_AGREEMENTS` in
-- artifacts/resupply-api/src/lib/agreements/index.ts. They are pinned here on
-- purpose: a future version bump should re-prompt, not be auto-accepted.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent
-- (ON CONFLICT DO NOTHING against the (org_id, agreement_type, version)
-- unique index; a real UI signing already present wins and is preserved).

INSERT INTO "resupply"."organization_agreements"
  ("org_id", "agreement_type", "version", "signatory_name")
SELECT
  o."id",
  v.agreement_type,
  v.version,
  'Grandfathered at platform-gate deployment (migration 0376)'
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('platform_terms', '2026-06-16'),
  ('baa', '2026-06-16')
) AS v(agreement_type, version)
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("org_id", "agreement_type", "version") DO NOTHING;
