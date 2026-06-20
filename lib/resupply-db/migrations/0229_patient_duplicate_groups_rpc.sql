-- 0229_patient_duplicate_groups_rpc — server-side fuzzy-ish duplicate
-- detection for the patient roster (CSR #C1, detection half).
--
-- Background: the only uniqueness enforced on resupply.patients is
-- pacware_id. DME intake from faxes / referrals / phone routinely
-- produces a second record for an existing patient (a first-name typo,
-- a maiden vs married last name, a re-keyed phone). CSRs had no way to
-- FIND those — there was no dedup surface at all. This function returns
-- the likely-duplicate groups so a CSR can review them. (The destructive
-- MERGE — repointing every patient_id FK across the schema — is a
-- deliberate, separate change; this is detection only.)
--
-- No pg_trgm: per CLAUDE.md the database ships no extensions, so this
-- uses deterministic blocking keys instead of trigram similarity:
--   * dob_lastname — same date_of_birth AND case/space-normalized last
--                    name (catches first-name typos, the common case)
--   * phone        — same phone_e164
--   * email        — same case/space-normalized email
-- A group is any key shared by >1 DISTINCT non-closed patient. Grouping
-- + the HAVING filter run in Postgres so the route receives only the
-- (small) set of actual collisions, never the whole roster.
--
-- Follows the established RPC pattern (0164 / 0228): SECURITY DEFINER +
-- pinned search_path + GRANT to service_role only, STABLE.
--
-- Per ADR 003 — versioned hand-authored migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.patient_duplicate_groups(
  p_max_groups integer DEFAULT 100
)
RETURNS TABLE(
  group_key text,
  match_reason text,
  patient_id uuid,
  legal_first_name text,
  legal_last_name text,
  date_of_birth text,
  pacware_id text,
  status text,
  has_phone boolean,
  has_email boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH keyed AS (
    SELECT
      pp.id AS pid,
      'dob_lastname'::text AS reason,
      'name|' || lower(btrim(pp.legal_last_name)) || '|'
        || coalesce(pp.date_of_birth, '') AS gkey
    FROM resupply.patients pp
    WHERE pp.status <> 'closed'
      AND pp.legal_last_name IS NOT NULL
      AND pp.date_of_birth IS NOT NULL
    UNION ALL
    SELECT pp.id, 'phone'::text, 'phone|' || btrim(pp.phone_e164)
    FROM resupply.patients pp
    WHERE pp.status <> 'closed'
      AND pp.phone_e164 IS NOT NULL
      AND btrim(pp.phone_e164) <> ''
    UNION ALL
    SELECT pp.id, 'email'::text, 'email|' || lower(btrim(pp.email))
    FROM resupply.patients pp
    WHERE pp.status <> 'closed'
      AND pp.email IS NOT NULL
      AND btrim(pp.email) <> ''
  ),
  dup_groups AS (
    SELECT k.gkey, k.reason
    FROM keyed k
    GROUP BY k.gkey, k.reason
    HAVING COUNT(DISTINCT k.pid) > 1
    ORDER BY COUNT(DISTINCT k.pid) DESC, k.gkey
    LIMIT p_max_groups
  )
  SELECT
    g.gkey AS group_key,
    g.reason AS match_reason,
    p.id AS patient_id,
    p.legal_first_name,
    p.legal_last_name,
    p.date_of_birth,
    p.pacware_id,
    p.status,
    (p.phone_e164 IS NOT NULL AND p.phone_e164 <> '') AS has_phone,
    (p.email IS NOT NULL AND p.email <> '') AS has_email,
    p.created_at
  FROM dup_groups g
  JOIN keyed k ON k.gkey = g.gkey AND k.reason = g.reason
  JOIN resupply.patients p ON p.id = k.pid
  ORDER BY g.gkey, p.created_at
$$;

GRANT EXECUTE ON FUNCTION resupply.patient_duplicate_groups(integer) TO service_role;
