-- 0116_audit_log_hmac_chain — tamper-evident signing on resupply.audit_log.
--
-- HIPAA §164.312(b) calls for audit logs that can demonstrate they
-- haven't been mutated since insertion. The append-only INSERT-only
-- contract (no UPDATE/DELETE outside the archive sweep) was the
-- start; this migration adds per-row HMAC-SHA-256 signatures
-- chained to the previous row's signature so a verifier can replay
-- the chain offline and detect any silent edit or excised row.
--
-- The signature is computed APPLICATION-side in `@workspace/resupply-audit`
-- using `RESUPPLY_AUDIT_HMAC_KEY`. The DB only enforces structural
-- invariants:
--
--   * chain_seq is monotone-unique across signed rows (UNIQUE index
--     scoped to `chain_seq IS NOT NULL` so legacy unsigned rows
--     don't clash).
--   * Either the row is fully signed (chain_seq + signature both
--     non-null) or fully unsigned (both null). prev_signature is
--     nullable in BOTH cases — it's null on the genesis row
--     (chain_seq = 1) and on every legacy unsigned row.
--
-- Why TEXT and not BYTEA: PostgREST's JSON representation of bytea
-- depends on the `bytea_output` server setting and round-trips
-- awkwardly. Storing base64-encoded text keeps the round-trip
-- lossless via the Supabase JS client and is the same shape the
-- application uses when computing signatures.
--
-- Why ADD then BACKFILL nothing: existing rows stay un-signed.
-- Re-signing history would require a one-time key and a verifiable
-- migration witness, neither of which is in scope here. The chain
-- starts at the first row written after this migration deploys; the
-- pre-signed rows remain available as an unsigned tail.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."audit_log"
  ADD COLUMN IF NOT EXISTS "chain_seq" bigint,
  ADD COLUMN IF NOT EXISTS "prev_signature" text,
  ADD COLUMN IF NOT EXISTS "signature" text;
--> statement-breakpoint

-- Unique index, not a unique constraint, so the partial predicate
-- (signed rows only) is supported. The application increments
-- chain_seq by reading the current MAX and retrying on the 23505
-- this index throws under concurrent inserts.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_chain_seq_uidx"
  ON "resupply"."audit_log" ("chain_seq")
  WHERE "chain_seq" IS NOT NULL;
--> statement-breakpoint

-- Reverse-ordered index on chain_seq makes "fetch the chain tip"
-- a constant-time lookup regardless of table size. Without it the
-- per-insert tip read degrades as the audit log grows.
CREATE INDEX IF NOT EXISTS "audit_log_chain_seq_desc_idx"
  ON "resupply"."audit_log" ("chain_seq" DESC)
  WHERE "chain_seq" IS NOT NULL;
--> statement-breakpoint

-- Pairing check: chain_seq and signature must be set together or
-- not at all. prev_signature is independent (null on genesis).
ALTER TABLE "resupply"."audit_log"
  DROP CONSTRAINT IF EXISTS "audit_log_signature_pair_chk";
--> statement-breakpoint
ALTER TABLE "resupply"."audit_log"
  ADD CONSTRAINT "audit_log_signature_pair_chk"
  CHECK (
    ("chain_seq" IS NULL AND "signature" IS NULL)
    OR
    ("chain_seq" IS NOT NULL AND "signature" IS NOT NULL)
  );
