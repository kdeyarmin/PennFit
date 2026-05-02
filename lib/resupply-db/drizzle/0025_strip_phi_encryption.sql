-- 0025_strip_phi_encryption.sql
--
-- Removes pgcrypto-based PHI encryption from the resupply schema.
-- After this migration:
--   * patients.{legal_first_name, legal_last_name, date_of_birth,
--     phone_e164, email}      -- bytea -> text
--   * patients.address         -- bytea -> jsonb
--   * prescriptions.details    -- bytea -> jsonb
--   * messages.body            -- bytea -> text
--   * patient_notes.body       -- bytea -> text
--   * patient_latest_message.last_message_preview -- bytea -> text
--   * resupply.phone_lookup    -- DROPPED
--   * patients.phone_e164      -- new btree index for the equality lookup
--                                 that phone_lookup used to serve
--
-- Decryption strategy
-- -------------------
-- This migration reads the data key via current_setting('app.data_key',
-- true). On a fresh deploy or any DB whose PHI tables have already
-- been decrypted, the key is unused and need not be set — the
-- preflight returns early before any pgp_sym_decrypt call is
-- resolved.
--
-- Historical (pre-task #32): the migrator (migrate.mjs) used to read
-- RESUPPLY_DATA_KEY from env and run `SET app.data_key = ?` on its
-- pinned session before invoking the drizzle migrator, so this
-- migration could decrypt legacy bytea rows on the way through. That
-- assist has been removed because every active environment is long
-- past 0025; if you ever need to replay against a pre-0025 PHI dump,
-- re-add the SET in migrate.mjs (and `CREATE EXTENSION pgcrypto`)
-- before running.
--
-- Reasons for current_setting() instead of a hard-coded secret:
--   * Avoids hard-coding any secret in the SQL (committed) file.
--   * SET (vs SET LOCAL) is session-scoped and would survive across
--     drizzle's per-migration BEGIN/COMMIT.
--   * current_setting(name, missing_ok=true) returns NULL if unset
--     instead of raising — lets us branch on "no key + no data".
--
-- Idempotency / safety
-- --------------------
-- Every column transform is wrapped in a per-column DO block that
-- short-circuits if the column is no longer bytea. This makes the
-- migration safe to re-apply against any partially-converted state
-- (e.g. after a manual fixup, a wiped __drizzle_migrations row, or
-- a rerun against an already-converted DB). The data-key check at
-- the top fails loudly only if encrypted bytea rows actually still
-- exist and no key was supplied.
--
-- Postgres-flavor portability (task #32)
-- --------------------------------------
-- Some managed Postgres offerings do not ship the pgcrypto extension.
-- The active resupply schema only needs `gen_random_uuid()` (in core
-- since v13), so a fresh deploy MUST be able to roll forward through
-- this migration without pgcrypto being installed. To make that
-- possible:
--
--   * The preflight below treats "no encrypted rows present" as the
--     pure-schema-swap path and never consults pgcrypto.
--   * Each per-column block calls pgp_sym_decrypt via a *dynamic*
--     EXECUTE, so the function reference is parsed and resolved by
--     Postgres only at the moment the EXECUTE actually fires. That
--     in turn only happens when we have rows to decrypt AND have
--     verified the extension is installed. On an empty / freshly-
--     created column, the EXECUTE branch is skipped and pgp_sym_decrypt
--     is never resolved — so its absence in the DB is not an error.
--   * If a partially-encrypted environment somehow makes it here
--     without pgcrypto, the preflight raises a clear, actionable
--     error before any DDL runs.

DO $preflight$
DECLARE
  data_key text := current_setting('app.data_key', true);
  encrypted_bytea_cols int := 0;
  total_encrypted_rows bigint := 0;
  table_row_count bigint;
  has_pgcrypto bool;
  pair RECORD;
  not_null_predicate text;
BEGIN
  -- Count remaining encrypted (bytea) columns across all PHI tables.
  -- The data-key gate must consider every table, not just patients,
  -- so a partially-converted DB (e.g. patients done, prescriptions
  -- still encrypted) doesn't sail past the check and crash later.
  SELECT count(*) INTO encrypted_bytea_cols
  FROM information_schema.columns
  WHERE table_schema = 'resupply'
    AND data_type = 'bytea'
    AND (
         (table_name = 'patients' AND column_name IN
            ('legal_first_name','legal_last_name','date_of_birth',
             'phone_e164','email','address'))
      OR (table_name = 'prescriptions' AND column_name = 'details')
      OR (table_name = 'messages' AND column_name = 'body')
      OR (table_name = 'patient_notes' AND column_name = 'body')
      OR (table_name = 'patient_latest_message'
          AND column_name = 'last_message_preview')
    );

  IF encrypted_bytea_cols = 0 THEN
    RAISE NOTICE '0025_strip_phi_encryption: no encrypted columns remain; running idempotent no-op.';
    RETURN;
  END IF;

  -- Count rows that actually need decryption — i.e. rows whose
  -- still-bytea PHI columns are NOT NULL. Whole-table row counts
  -- would over-count: a partially-converted DB (some columns
  -- already decrypted to text, others still bytea) or a table
  -- where the bytea column was independently NULLed could
  -- false-trigger the hard-error gates below even though there is
  -- nothing left to decrypt. We only need the data-key and
  -- pgcrypto when there's actual ciphertext to read.
  --
  -- Per-table: find the still-bytea PHI columns, build a
  -- "col_a IS NOT NULL OR col_b IS NOT NULL" predicate, and count
  -- rows matching it. Skip tables with no remaining bytea PHI.
  FOR pair IN
    SELECT * FROM (VALUES
      ('patients',                ARRAY['legal_first_name','legal_last_name','date_of_birth','phone_e164','email','address']),
      ('prescriptions',           ARRAY['details']),
      ('messages',                ARRAY['body']),
      ('patient_notes',           ARRAY['body']),
      ('patient_latest_message',  ARRAY['last_message_preview'])
    ) AS t(tname, cols)
  LOOP
    SELECT string_agg(quote_ident(column_name) || ' IS NOT NULL', ' OR ')
      INTO not_null_predicate
      FROM information_schema.columns
     WHERE table_schema = 'resupply'
       AND table_name = pair.tname
       AND data_type = 'bytea'
       AND column_name = ANY(pair.cols);

    IF not_null_predicate IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM resupply.%I WHERE %s',
        pair.tname, not_null_predicate
      ) INTO table_row_count;
      total_encrypted_rows := total_encrypted_rows + table_row_count;
    END IF;
  END LOOP;

  IF total_encrypted_rows = 0 THEN
    RAISE NOTICE '0025_strip_phi_encryption: % encrypted bytea column(s) remain but contain zero non-NULL rows; running pure schema swap (pgcrypto not required).', encrypted_bytea_cols;
    RETURN;
  END IF;

  -- We have rows to decrypt. Verify both prerequisites are present
  -- BEFORE we start mutating schema, so a partial run can't strand
  -- the DB half-converted.
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto')
    INTO has_pgcrypto;

  IF NOT has_pgcrypto THEN
    RAISE EXCEPTION 'Cannot strip PHI encryption: % encrypted bytea columns still hold % rows but the pgcrypto extension is not installed in this database. pgcrypto is required only to decrypt legacy rows on the way through this migration; install it (CREATE EXTENSION pgcrypto) and re-run, or restore from a dump that has been pre-decrypted.', encrypted_bytea_cols, total_encrypted_rows;
  END IF;

  IF data_key IS NULL OR data_key = '' THEN
    RAISE EXCEPTION 'Cannot strip PHI encryption: % encrypted bytea columns still hold % rows but app.data_key is not set. Set RESUPPLY_DATA_KEY in the deploy environment so the migrator can decrypt existing data, then re-run.', encrypted_bytea_cols, total_encrypted_rows;
  END IF;

  RAISE NOTICE '0025_strip_phi_encryption: decrypting up to % rows across % encrypted columns.', total_encrypted_rows, encrypted_bytea_cols;
END
$preflight$;
--> statement-breakpoint

-- ============================================================
-- patients
-- ============================================================
-- Each block is a no-op if the column has already been converted
-- (i.e. it's no longer bytea). That guard makes a re-run safe even
-- after a successful prior application: the prior run renamed the
-- *__plain temp column to the original name, so a naive re-run
-- would otherwise call pgp_sym_decrypt on a text/jsonb column and
-- crash.

-- Per-column transform pattern (task #32):
--   1. Bail out if the column has already been converted.
--   2. Add the destination column.
--   3. Check whether any source rows actually carry data. If yes,
--      decrypt via dynamic EXECUTE so pgp_sym_decrypt is parsed
--      ONLY at the moment of execution (and only when we know the
--      extension is installed, by virtue of the preflight gate).
--      If no rows have data, skip decryption entirely — this is the
--      path a fresh DB takes and it never touches pgcrypto.
--   4. Drop the old column, rename the new one into place, and
--      re-apply NOT NULL where the original column carried it.

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='legal_first_name' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS legal_first_name__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE legal_first_name IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET legal_first_name__plain = pgp_sym_decrypt(legal_first_name, current_setting('app.data_key', true))
      WHERE legal_first_name__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN legal_first_name;
  ALTER TABLE resupply.patients RENAME COLUMN legal_first_name__plain TO legal_first_name;
  ALTER TABLE resupply.patients ALTER COLUMN legal_first_name SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='legal_last_name' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS legal_last_name__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE legal_last_name IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET legal_last_name__plain = pgp_sym_decrypt(legal_last_name, current_setting('app.data_key', true))
      WHERE legal_last_name__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN legal_last_name;
  ALTER TABLE resupply.patients RENAME COLUMN legal_last_name__plain TO legal_last_name;
  ALTER TABLE resupply.patients ALTER COLUMN legal_last_name SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='date_of_birth' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS date_of_birth__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE date_of_birth IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET date_of_birth__plain = pgp_sym_decrypt(date_of_birth, current_setting('app.data_key', true))
      WHERE date_of_birth__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN date_of_birth;
  ALTER TABLE resupply.patients RENAME COLUMN date_of_birth__plain TO date_of_birth;
  ALTER TABLE resupply.patients ALTER COLUMN date_of_birth SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='phone_e164' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS phone_e164__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE phone_e164 IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET phone_e164__plain = pgp_sym_decrypt(phone_e164, current_setting('app.data_key', true))
      WHERE phone_e164 IS NOT NULL AND phone_e164__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN phone_e164;
  ALTER TABLE resupply.patients RENAME COLUMN phone_e164__plain TO phone_e164;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='email' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS email__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE email IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET email__plain = pgp_sym_decrypt(email, current_setting('app.data_key', true))
      WHERE email IS NOT NULL AND email__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN email;
  ALTER TABLE resupply.patients RENAME COLUMN email__plain TO email;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='address' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS address__plain jsonb;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patients WHERE address IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patients
      SET address__plain = pgp_sym_decrypt(address, current_setting('app.data_key', true))::jsonb
      WHERE address IS NOT NULL AND address__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patients DROP COLUMN address;
  ALTER TABLE resupply.patients RENAME COLUMN address__plain TO address;
END
$migrate$;
--> statement-breakpoint

-- New equality-lookup index for phone_e164 (replaces phone_lookup table).
CREATE INDEX IF NOT EXISTS patients_phone_e164_idx ON resupply.patients (phone_e164);
--> statement-breakpoint

-- ============================================================
-- prescriptions
-- ============================================================
DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='prescriptions'
      AND column_name='details' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.prescriptions ADD COLUMN IF NOT EXISTS details__plain jsonb;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.prescriptions WHERE details IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.prescriptions
      SET details__plain = pgp_sym_decrypt(details, current_setting('app.data_key', true))::jsonb
      WHERE details IS NOT NULL AND details__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.prescriptions DROP COLUMN details;
  ALTER TABLE resupply.prescriptions RENAME COLUMN details__plain TO details;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- messages
-- ============================================================
DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='messages'
      AND column_name='body' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.messages ADD COLUMN IF NOT EXISTS body__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.messages WHERE body IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.messages
      SET body__plain = pgp_sym_decrypt(body, current_setting('app.data_key', true))
      WHERE body__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.messages DROP COLUMN body;
  ALTER TABLE resupply.messages RENAME COLUMN body__plain TO body;
  ALTER TABLE resupply.messages ALTER COLUMN body SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- patient_notes
-- ============================================================
DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patient_notes'
      AND column_name='body' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patient_notes ADD COLUMN IF NOT EXISTS body__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patient_notes WHERE body IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patient_notes
      SET body__plain = pgp_sym_decrypt(body, current_setting('app.data_key', true))
      WHERE body__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patient_notes DROP COLUMN body;
  ALTER TABLE resupply.patient_notes RENAME COLUMN body__plain TO body;
  ALTER TABLE resupply.patient_notes ALTER COLUMN body SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- patient_latest_message
-- ============================================================
DO $migrate$
DECLARE has_rows bool;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patient_latest_message'
      AND column_name='last_message_preview' AND data_type='bytea'
  ) THEN RETURN; END IF;

  ALTER TABLE resupply.patient_latest_message ADD COLUMN IF NOT EXISTS last_message_preview__plain text;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM resupply.patient_latest_message WHERE last_message_preview IS NOT NULL)' INTO has_rows;
  IF has_rows THEN
    EXECUTE $sql$
      UPDATE resupply.patient_latest_message
      SET last_message_preview__plain = pgp_sym_decrypt(last_message_preview, current_setting('app.data_key', true))
      WHERE last_message_preview__plain IS NULL
    $sql$;
  END IF;
  ALTER TABLE resupply.patient_latest_message DROP COLUMN last_message_preview;
  ALTER TABLE resupply.patient_latest_message RENAME COLUMN last_message_preview__plain TO last_message_preview;
  ALTER TABLE resupply.patient_latest_message ALTER COLUMN last_message_preview SET NOT NULL;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- phone_lookup — drop entire table
-- ============================================================
-- Phone numbers now live in plaintext in patients.phone_e164 with a
-- direct btree index (created above), so the HMAC-keyed lookup table
-- is obsolete.
DROP TABLE IF EXISTS resupply.phone_lookup;
