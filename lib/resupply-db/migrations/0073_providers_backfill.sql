-- Best-effort backfill: synthesize providers rows from the jsonb
-- prescriber data on existing prescriptions, and link each
-- prescription to its provider via the FK added in 0072.
--
-- Strategy
-- --------
--   1. Pull every distinct (NPI, prescriberName) pair from
--      prescriptions.details, normalize, and insert one providers
--      row per distinct NPI with source='backfill'. Conflicts on NPI
--      (which can happen if the prescriptions table already has the
--      same NPI under multiple names) are resolved by keeping the
--      first inserted row — we don't try to be smart about which
--      spelling is "correct"; the CSR review queue surfaces these
--      for confirmation.
--   2. Update each prescription's provider_id to point at the
--      provider row matched by NPI.
--   3. Prescriptions whose jsonb has a name but no NPI (the common
--      "Dr. Smith" case from the early days) are left with
--      provider_id NULL. The admin UI surfaces these as "needs
--      provider link" so a CSR can run an NPPES lookup and connect
--      them.
--
-- This migration is idempotent: ON CONFLICT DO NOTHING on the NPI
-- unique key means re-running is a no-op once applied. The UPDATE
-- step is also idempotent — it re-resolves the link from the same
-- jsonb data, producing the same FK either way.
--
-- Why this lives in its own migration (not bundled into 0071)
-- ----------------------------------------------------------
-- The schema and the data backfill have different failure modes.
-- If the backfill crashes on bad jsonb in some specific row, we
-- want the schema to have landed already so a manual SQL fix can
-- complete the link without re-running 0071. Splitting also makes
-- the schema migration replayable against any prod-like DB
-- regardless of jsonb data quality.

-- Step 1: insert one providers row per distinct NPI present in the
-- prescriptions jsonb. The legal_name picks the first non-null
-- prescriberName for that NPI (Postgres' MIN over text gives a
-- deterministic-but-arbitrary choice; we don't have a "most recent"
-- signal since these are jsonb fields without provenance).
INSERT INTO "resupply"."providers" (npi, legal_name, source)
SELECT
  TRIM(details->>'prescriberNpi') AS npi,
  COALESCE(MIN(NULLIF(TRIM(details->>'prescriberName'), '')), 'Unknown (backfill)') AS legal_name,
  'backfill' AS source
FROM "resupply"."prescriptions"
WHERE details ? 'prescriberNpi'
  AND TRIM(details->>'prescriberNpi') ~ '^[0-9]{10}$'
GROUP BY TRIM(details->>'prescriberNpi')
ON CONFLICT (npi) DO NOTHING;

-- Step 2: link each prescription to its provider row.
UPDATE "resupply"."prescriptions" rx
SET provider_id = p.id
FROM "resupply"."providers" p
WHERE rx.provider_id IS NULL
  AND rx.details ? 'prescriberNpi'
  AND TRIM(rx.details->>'prescriberNpi') ~ '^[0-9]{10}$'
  AND p.npi = TRIM(rx.details->>'prescriberNpi');
