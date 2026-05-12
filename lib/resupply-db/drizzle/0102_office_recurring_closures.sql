-- office_recurring_closures — weekly closure pattern (e.g. "every
-- Sunday"). See schema/office-recurring-closures.ts for the full
-- rationale (separate from office_closures because recurrence + time
-- of day is a different model from an absolute range).

CREATE TABLE IF NOT EXISTS "resupply"."office_recurring_closures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" varchar(200) NOT NULL,
  "day_of_week" integer NOT NULL,
  "start_time_utc" time NOT NULL,
  "end_time_utc" time NOT NULL,
  "auto_reply_message" varchar(320) NOT NULL,
  "active" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "office_recurring_closures_day_valid"
    CHECK ("day_of_week" >= 0 AND "day_of_week" <= 6)
);

CREATE INDEX IF NOT EXISTS "office_recurring_closures_day_idx"
  ON "resupply"."office_recurring_closures" ("day_of_week");
