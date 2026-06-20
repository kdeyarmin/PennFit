-- 0026_normalize_legacy_id_columns — finish normalising legacy
-- admin/operator/author id column names to provider-neutral form.
--
-- Stage 5d.4 of the in-house auth cutover. Earlier stages
-- removed the legacy auth SDK and renamed the JS-side
-- identifiers to neutral names (`adminUserId`,
-- `assignedAdminUserId`, `authorUserId`, `operator…UserId`).
-- The Postgres column names were left in place for back-compat;
-- this migration brings them in line with the JS naming.
--
-- Touched columns (rename, no value change):
--   * resupply.shop_returns           legacy id   -> admin_user_id
--   * resupply.conversations          legacy id   -> assigned_admin_user_id
--   * resupply.patient_notes          legacy id   -> author_user_id
--   * resupply.audit_log              legacy id   -> operator_user_id
--
-- All four columns are plain `text` with no FK, no UNIQUE
-- constraint, and no auto-generated index name embedding the
-- column. The only index that touches one of them is the partial
-- `conversations_assignee_active_idx` on
-- (the renamed column, status), and Postgres rewrites the
-- index's column reference automatically when the column itself
-- is renamed -- the index name is neutral so it needs no
-- `ALTER INDEX`.
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
