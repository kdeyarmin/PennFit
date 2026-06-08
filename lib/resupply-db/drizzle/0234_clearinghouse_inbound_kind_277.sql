-- 0234_clearinghouse_inbound_kind_277 — extend file_kind CHECK to allow '277'.
--
-- The 276/277 claim-status flow (biller #B3) lands real 277 (X212)
-- claim-status responses in clearinghouse_inbound_files with
-- file_kind = '277'. The existing CHECK constraint only covers
-- ('999', '277ca', '835', '271', 'unknown'); add '277' so inserts
-- for inbound 277 responses don't fail at the DB level.

ALTER TABLE "resupply"."clearinghouse_inbound_files"
  DROP CONSTRAINT IF EXISTS "clearinghouse_inbound_files_kind_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."clearinghouse_inbound_files"
  ADD CONSTRAINT "clearinghouse_inbound_files_kind_enum"
    CHECK ("file_kind" IN ('999', '277ca', '277', '835', '271', 'unknown'));
