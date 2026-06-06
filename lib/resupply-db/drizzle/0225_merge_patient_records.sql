-- 0225_merge_patient_records — atomic patient-record merge (CSR #C1,
-- merge half). Detection shipped in 0223; this is the consolidation.
--
-- DME intake creates duplicate patient records; a CSR picks the survivor
-- (primary) and a duplicate to fold in. This function repoints every
-- foreign key that references resupply.patients(id) from the duplicate to
-- the primary, then marks the duplicate merged. It is SAFE BY
-- CONSTRUCTION:
--   * Atomic — the whole thing runs in the caller's statement, so ANY
--     error (notably a unique-constraint 23505 when a one-row-per-patient
--     child already exists for the primary) rolls back EVERY repoint. A
--     merge either fully succeeds or changes nothing; it never half-merges.
--   * Dynamic FK discovery — it finds the referencing columns from the
--     catalog, so a table added later is covered automatically; nothing is
--     silently missed.
--   * Non-destructive — the duplicate row is marked status='closed' +
--     merged_into_patient_id, NOT deleted. The merge is recoverable and
--     the duplicate-detection RPC (0223) already excludes closed rows.
--
-- The route maps the RAISEd SQLSTATEs: 23505 -> 409 conflict (CSR
-- resolves by hand), P0001 -> 400 same patient, P0002 -> 404 not found,
-- P0003 -> 409 already merged.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "merged_into_patient_id" uuid
    REFERENCES "resupply"."patients"("id");
--> statement-breakpoint
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.merge_patient_records(
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

  PERFORM 1 FROM resupply.patients WHERE id = p_primary;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'primary patient not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT merged_into_patient_id INTO v_dup_merged
  FROM resupply.patients WHERE id = p_duplicate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dup_merged IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate is already merged' USING ERRCODE = 'P0003';
  END IF;

  -- Repoint every single-column FK that references resupply.patients(id),
  -- across all schemas, EXCEPT the lineage self-reference column added
  -- above (a merged duplicate must keep pointing at its primary).
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
  WHERE id = p_duplicate;

  RETURN jsonb_build_object(
    'tablesRepointed', v_tables,
    'rowsRepointed', v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION resupply.merge_patient_records(uuid, uuid) TO service_role;
