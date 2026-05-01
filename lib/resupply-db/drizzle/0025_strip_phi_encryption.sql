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
-- The migrator (lib/resupply-db/scripts/migrate.mjs) reads
-- RESUPPLY_DATA_KEY from env and runs `SET app.data_key = ?` on its
-- pinned session BEFORE invoking the drizzle migrator. This migration
-- reads the key via current_setting('app.data_key', true). Reasons:
--   * Avoids hard-coding any secret in the SQL (committed) file.
--   * SET (vs SET LOCAL) is session-scoped, which survives
--     across drizzle's per-migration BEGIN/COMMIT.
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

DO $preflight$
DECLARE
  data_key text := current_setting('app.data_key', true);
  encrypted_bytea_cols int := 0;
  total_encrypted_rows bigint := 0;
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

  -- Sum row counts across the still-encrypted tables. We only need
  -- the data-key when there's something to decrypt.
  EXECUTE $sql$
    SELECT (SELECT count(*) FROM resupply.patients)
         + (SELECT count(*) FROM resupply.prescriptions)
         + (SELECT count(*) FROM resupply.messages)
         + (SELECT count(*) FROM resupply.patient_notes)
         + (SELECT count(*) FROM resupply.patient_latest_message)
  $sql$ INTO total_encrypted_rows;

  IF total_encrypted_rows = 0 THEN
    RAISE NOTICE '0025_strip_phi_encryption: no rows to decrypt across % encrypted columns; running pure schema swap.', encrypted_bytea_cols;
  ELSIF data_key IS NULL OR data_key = '' THEN
    RAISE EXCEPTION 'Cannot strip PHI encryption: % encrypted bytea columns still hold % rows but app.data_key is not set. Set RESUPPLY_DATA_KEY in the deploy environment so the migrator can decrypt existing data, then re-run.', encrypted_bytea_cols, total_encrypted_rows;
  ELSE
    RAISE NOTICE '0025_strip_phi_encryption: decrypting up to % rows across % encrypted columns.', total_encrypted_rows, encrypted_bytea_cols;
  END IF;
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

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='legal_first_name' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS legal_first_name__plain text;
    UPDATE resupply.patients
    SET legal_first_name__plain = pgp_sym_decrypt(legal_first_name, current_setting('app.data_key', true))
    WHERE legal_first_name__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN legal_first_name;
    ALTER TABLE resupply.patients RENAME COLUMN legal_first_name__plain TO legal_first_name;
    ALTER TABLE resupply.patients ALTER COLUMN legal_first_name SET NOT NULL;
  END IF;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='legal_last_name' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS legal_last_name__plain text;
    UPDATE resupply.patients
    SET legal_last_name__plain = pgp_sym_decrypt(legal_last_name, current_setting('app.data_key', true))
    WHERE legal_last_name__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN legal_last_name;
    ALTER TABLE resupply.patients RENAME COLUMN legal_last_name__plain TO legal_last_name;
    ALTER TABLE resupply.patients ALTER COLUMN legal_last_name SET NOT NULL;
  END IF;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='date_of_birth' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS date_of_birth__plain text;
    UPDATE resupply.patients
    SET date_of_birth__plain = pgp_sym_decrypt(date_of_birth, current_setting('app.data_key', true))
    WHERE date_of_birth__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN date_of_birth;
    ALTER TABLE resupply.patients RENAME COLUMN date_of_birth__plain TO date_of_birth;
    ALTER TABLE resupply.patients ALTER COLUMN date_of_birth SET NOT NULL;
  END IF;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='phone_e164' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS phone_e164__plain text;
    UPDATE resupply.patients
    SET phone_e164__plain = pgp_sym_decrypt(phone_e164, current_setting('app.data_key', true))
    WHERE phone_e164 IS NOT NULL AND phone_e164__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN phone_e164;
    ALTER TABLE resupply.patients RENAME COLUMN phone_e164__plain TO phone_e164;
  END IF;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='email' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS email__plain text;
    UPDATE resupply.patients
    SET email__plain = pgp_sym_decrypt(email, current_setting('app.data_key', true))
    WHERE email IS NOT NULL AND email__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN email;
    ALTER TABLE resupply.patients RENAME COLUMN email__plain TO email;
  END IF;
END
$migrate$;
--> statement-breakpoint

DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patients'
      AND column_name='address' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patients ADD COLUMN IF NOT EXISTS address__plain jsonb;
    UPDATE resupply.patients
    SET address__plain = pgp_sym_decrypt(address, current_setting('app.data_key', true))::jsonb
    WHERE address IS NOT NULL AND address__plain IS NULL;
    ALTER TABLE resupply.patients DROP COLUMN address;
    ALTER TABLE resupply.patients RENAME COLUMN address__plain TO address;
  END IF;
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
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='prescriptions'
      AND column_name='details' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.prescriptions ADD COLUMN IF NOT EXISTS details__plain jsonb;
    UPDATE resupply.prescriptions
    SET details__plain = pgp_sym_decrypt(details, current_setting('app.data_key', true))::jsonb
    WHERE details IS NOT NULL AND details__plain IS NULL;
    ALTER TABLE resupply.prescriptions DROP COLUMN details;
    ALTER TABLE resupply.prescriptions RENAME COLUMN details__plain TO details;
  END IF;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- messages
-- ============================================================
DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='messages'
      AND column_name='body' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.messages ADD COLUMN IF NOT EXISTS body__plain text;
    UPDATE resupply.messages
    SET body__plain = pgp_sym_decrypt(body, current_setting('app.data_key', true))
    WHERE body__plain IS NULL;
    ALTER TABLE resupply.messages DROP COLUMN body;
    ALTER TABLE resupply.messages RENAME COLUMN body__plain TO body;
    ALTER TABLE resupply.messages ALTER COLUMN body SET NOT NULL;
  END IF;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- patient_notes
-- ============================================================
DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patient_notes'
      AND column_name='body' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patient_notes ADD COLUMN IF NOT EXISTS body__plain text;
    UPDATE resupply.patient_notes
    SET body__plain = pgp_sym_decrypt(body, current_setting('app.data_key', true))
    WHERE body__plain IS NULL;
    ALTER TABLE resupply.patient_notes DROP COLUMN body;
    ALTER TABLE resupply.patient_notes RENAME COLUMN body__plain TO body;
    ALTER TABLE resupply.patient_notes ALTER COLUMN body SET NOT NULL;
  END IF;
END
$migrate$;
--> statement-breakpoint

-- ============================================================
-- patient_latest_message
-- ============================================================
DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='resupply' AND table_name='patient_latest_message'
      AND column_name='last_message_preview' AND data_type='bytea'
  ) THEN
    ALTER TABLE resupply.patient_latest_message ADD COLUMN IF NOT EXISTS last_message_preview__plain text;
    UPDATE resupply.patient_latest_message
    SET last_message_preview__plain = pgp_sym_decrypt(last_message_preview, current_setting('app.data_key', true))
    WHERE last_message_preview__plain IS NULL;
    ALTER TABLE resupply.patient_latest_message DROP COLUMN last_message_preview;
    ALTER TABLE resupply.patient_latest_message RENAME COLUMN last_message_preview__plain TO last_message_preview;
    ALTER TABLE resupply.patient_latest_message ALTER COLUMN last_message_preview SET NOT NULL;
  END IF;
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
