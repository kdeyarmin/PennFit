-- 0344_patient_dedup_rpcs_org_scoped — tenant-scope the two patient
-- dedup RPCs (CSR #C1) for multi-tenant Phase 0 (plan workstream C/D).
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md.
--
-- Background: the duplicate-detection RPC (0229) and the merge RPC
-- (0225) both scan / mutate resupply.patients with NO org filter. After
-- the org_id backfill (0331-0342) every patient row carries an org_id,
-- but these SECURITY DEFINER functions still operate roster-wide — a
-- CSR signed into org A would see org B's collisions and could merge
-- across tenants. That is exactly the cross-tenant leak the Phase 0
-- chokepoint exists to close, and because these are RPCs (not `.from()`
-- table access) the org-scoped client facade cannot scope them — the
-- scoping has to live inside the function.
--
-- This migration replaces both functions with org-aware signatures that
-- take `p_org_id uuid` and constrain every patients read/write to it.
-- The route layer (duplicates.ts / merge.ts) passes req.orgId. With one
-- org today (seed 'penn-home-medical', every row backfilled to it) this
-- is behavior-preserving; it becomes a hard isolation boundary the
-- moment a second tenant exists.
--
-- We DROP the old single-/two-arg signatures so the unscoped versions
-- are no longer callable (a new arg makes CREATE OR REPLACE add an
-- overload rather than replace, so the drop is required).
--
-- Per ADR 003 — versioned hand-authored migration. SECURITY DEFINER +
-- pinned search_path + GRANT to service_role only, matching 0225/0229.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── patient_duplicate_groups: org-scoped detection ──────────────────
DROP FUNCTION IF EXISTS resupply.patient_duplicate_groups(integer);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.patient_duplicate_groups(
  p_org_id uuid,
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
    WHERE pp.org_id = p_org_id
      AND pp.status <> 'closed'
      AND pp.legal_last_name IS NOT NULL
      AND pp.date_of_birth IS NOT NULL
    UNION ALL
    SELECT pp.id, 'phone'::text, 'phone|' || btrim(pp.phone_e164)
    FROM resupply.patients pp
    WHERE pp.org_id = p_org_id
      AND pp.status <> 'closed'
      AND pp.phone_e164 IS NOT NULL
      AND btrim(pp.phone_e164) <> ''
    UNION ALL
    SELECT pp.id, 'email'::text, 'email|' || lower(btrim(pp.email))
    FROM resupply.patients pp
    WHERE pp.org_id = p_org_id
      AND pp.status <> 'closed'
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
  JOIN resupply.patients p ON p.id = k.pid AND p.org_id = p_org_id
  ORDER BY g.gkey, p.created_at
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.patient_duplicate_groups(uuid, integer) TO service_role;
--> statement-breakpoint

-- ── merge_patient_records: org-scoped merge ─────────────────────────
DROP FUNCTION IF EXISTS resupply.merge_patient_records(uuid, uuid);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.merge_patient_records(
  p_org_id uuid,
  p_primary uuid,
  p_duplicate uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  fk record;
  v_rows bigint;
  v_total bigint := 0;
  v_tables integer := 0;
  v_dup_merged uuid;
BEGIN
  IF p_primary = p_duplicate THEN
    RAISE EXCEPTION 'cannot merge a patient into itself'
      USING ERRCODE = 'P0001';
  END IF;

  -- Both records must belong to the calling tenant. Scoping the lookups
  -- by org_id means a cross-tenant id pair surfaces as P0002 (not found)
  -- rather than silently merging across orgs.
  PERFORM 1 FROM resupply.patients
   WHERE id = p_primary AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'primary patient not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT merged_into_patient_id INTO v_dup_merged
  FROM resupply.patients
   WHERE id = p_duplicate AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dup_merged IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate is already merged' USING ERRCODE = 'P0003';
  END IF;

  -- Repoint every single-column FK that references resupply.patients(id),
  -- across all schemas, EXCEPT the lineage self-reference column (a
  -- merged duplicate must keep pointing at its primary). The repoint is
  -- keyed on the duplicate's id; since both patients are confirmed to be
  -- in p_org_id above, every child row reached this way belongs to the
  -- same tenant by FK construction.
  FOR fk IN
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'resupply.patients'::regclass
      AND array_length(con.conkey, 1) = 1
  LOOP
    IF fk.schema_name = 'resupply'
       AND fk.table_name = 'patients'
       AND fk.column_name = 'merged_into_patient_id' THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
      fk.schema_name, fk.table_name, fk.column_name, fk.column_name
    ) USING p_primary, p_duplicate;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      v_tables := v_tables + 1;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;

  UPDATE resupply.patients
  SET status = 'closed',
      merged_into_patient_id = p_primary,
      merged_at = now(),
      updated_at = now()
  WHERE id = p_duplicate AND org_id = p_org_id;

  RETURN jsonb_build_object(
    'tablesRepointed', v_tables,
    'rowsRepointed', v_total
  );
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.merge_patient_records(uuid, uuid, uuid) TO service_role;
