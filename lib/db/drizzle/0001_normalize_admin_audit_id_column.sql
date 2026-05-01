-- 0001_normalize_admin_audit_id_column — finish normalising the
-- admin id column on the cpap-fitter `admin_audit_log` table.
--
-- The 0000 baseline created a legacy admin id column back when
-- admin identity came from an external SDK. The fitter has since
-- moved fully to in-house auth (`@workspace/resupply-auth`); the
-- value stored in this column is now an opaque admin user id, so
-- the legacy name is misleading. This migration brings it in line
-- with the JS naming.
--
-- Touched columns (rename, no value change):
--   * admin_audit_log   legacy id  ->  admin_user_id
--
-- The column is plain `text NOT NULL` with no FK and no index
-- whose name embeds the column. Metadata-only rename; no table
-- rewrite, no data conversion. To roll back, rename in reverse.
--
-- Per ADR 003 -- versioned hand-authored migration.

ALTER TABLE "admin_audit_log"
  RENAME COLUMN "admin_clerk_id" TO "admin_user_id";
