-- 0026_rename_legacy_clerk_id_columns — drop the last Clerk-era
-- column names from the resupply schema.
--
-- Stage 5d.4 of the Clerk -> in-house migration. Earlier stages
-- removed the Clerk SDK and cut the JS-side identifiers over to
-- neutral names (`adminUserId`, `assignedAdminUserId`,
-- `authorUserId`, `operator…UserId`). The Postgres column names
-- were left as `*_clerk_id` for back-compat. Task #36 closes that
-- loop: every Drizzle `text("…")` reference and every raw SQL
-- query in the codebase has been moved off the legacy names, so
-- the columns can finally be renamed.
--
-- Touched columns:
--   * resupply.shop_returns.admin_clerk_id           -> admin_user_id
--   * resupply.conversations.assigned_admin_clerk_id -> assigned_admin_user_id
--   * resupply.patient_notes.author_clerk_id         -> author_user_id
--   * resupply.audit_log.operator_clerk_id           -> operator_user_id
--
-- All four columns are plain `text` with no FK, no UNIQUE
-- constraint, and no auto-generated index name embedding the
-- column. The only index that touches one of them is the partial
-- `conversations_assignee_active_idx` on
-- (assigned_admin_clerk_id, status), and Postgres rewrites the
-- index's column reference automatically when the column itself
-- is renamed -- the index name doesn't include `clerk` so it
-- needs no `ALTER INDEX`.
--
-- This migration is metadata-only (no table rewrite, no data
-- conversion). To roll back, rename each column in the inverse
-- direction.
--
-- Per ADR 003 -- versioned hand-authored migration.

ALTER TABLE "resupply"."shop_returns"
  RENAME COLUMN "admin_clerk_id" TO "admin_user_id";

ALTER TABLE "resupply"."conversations"
  RENAME COLUMN "assigned_admin_clerk_id" TO "assigned_admin_user_id";

ALTER TABLE "resupply"."patient_notes"
  RENAME COLUMN "author_clerk_id" TO "author_user_id";

ALTER TABLE "resupply"."audit_log"
  RENAME COLUMN "operator_clerk_id" TO "operator_user_id";
