-- Data migration: rename conversations.status legacy enum value
-- "awaiting_operator" → "awaiting_admin" to match the renamed
-- TS enum and dashboard copy. The column is plain text (drizzle's
-- text-enum is TS-only, never enforced at the DB level), so no
-- schema change is required — only an UPDATE of any rows that
-- carry the legacy value. Idempotent: re-applying the migration
-- updates zero rows once the rename has happened.
UPDATE "resupply"."conversations"
   SET "status" = 'awaiting_admin', "updated_at" = now()
 WHERE "status" = 'awaiting_operator';
