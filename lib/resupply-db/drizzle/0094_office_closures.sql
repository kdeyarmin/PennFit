-- office_closures — CSR-curated office closure windows.
-- See schema/office-closures.ts for the full rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."office_closures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" varchar(200) NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "auto_reply_message" varchar(320) NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "office_closures_range_valid"
    CHECK ("ends_at" > "starts_at")
);

CREATE INDEX IF NOT EXISTS "office_closures_ends_at_idx"
  ON "resupply"."office_closures" ("ends_at");
