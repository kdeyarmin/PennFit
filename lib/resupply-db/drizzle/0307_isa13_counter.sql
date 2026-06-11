-- 0306_isa13_counter.sql
--
-- Atomic ISA13 (interchange control number) allocation.
--
-- Why: ISA13 must be strictly monotonic per trading partner — Office
-- Ally rejects a re-used number at the 999 stage. Allocation used to be
-- "read MAX(isa_control_number) from office_ally_submissions, add 1",
-- which had two failure modes:
--   1. POOL VISIBILITY — eligibility 270s persist their ISA13 into
--      eligibility_checks, NOT office_ally_submissions, so the MAX read
--      never saw them: two eligibility checks built in the same
--      wall-clock second collided DETERMINISTICALLY (same time-derived
--      base, same invisible pool).
--   2. RACE — two concurrent submissions both read the same MAX before
--      either inserts (PostgREST has no transactions), minting the same
--      number. The row insert happens AFTER the SFTP upload, so even a
--      unique index would fire too late — the duplicate is already on
--      the wire.
-- A counter row CAS-incremented BEFORE the file is built closes both:
-- reservation is atomic (UPDATE ... WHERE value = <seen> matches at
-- most one concurrent caller) and shared by every pool participant.
--
-- Seeding: GREATEST of the existing maxima across BOTH tables and the
-- allocator's time-derived base, so the first reserved value continues
-- the historical sequence. ON CONFLICT DO NOTHING keeps re-runs and
-- replays idempotent (the live counter is never reset).
CREATE TABLE IF NOT EXISTS "resupply"."control_number_counters" (
  "pool" text PRIMARY KEY,
  "value" bigint NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "resupply"."control_number_counters" TO service_role;
--> statement-breakpoint
INSERT INTO "resupply"."control_number_counters" ("pool", "value")
SELECT
  'office_ally_isa13',
  GREATEST(
    COALESCE(
      (
        SELECT MAX(NULLIF(regexp_replace(s."isa_control_number", '\D', '', 'g'), '')::bigint)
        FROM "resupply"."office_ally_submissions" s
      ),
      0
    ),
    COALESCE(
      (
        SELECT MAX(NULLIF(regexp_replace(e."isa_control_number", '\D', '', 'g'), '')::bigint)
        FROM "resupply"."eligibility_checks" e
      ),
      0
    ),
    -- Allocator time base: (seconds since 2025-01-01Z) * 10.
    (EXTRACT(EPOCH FROM now())::bigint - 1735689600) * 10
  )
ON CONFLICT ("pool") DO NOTHING;
