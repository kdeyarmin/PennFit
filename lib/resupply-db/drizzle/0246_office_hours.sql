-- 0246_office_hours — standard weekly office hours (the "open by default"
-- baseline) + a seeded, editable office-hours message template.
--
-- `office_hours` is the positive statement of when the practice is open —
-- one row per open window per weekday. It complements office_closures /
-- office_recurring_closures, which are the explicit "closed" exceptions
-- (holidays, weekends) that also drive the inbound-SMS auto-reply. The
-- company calendar shades time outside office hours as unavailable and
-- defaults new appointments into the open window.
--
-- Times are UTC `time` (no date), matching office_recurring_closures.

CREATE TABLE IF NOT EXISTS "resupply"."office_hours" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "day_of_week" integer NOT NULL,
  "open_time_utc" time NOT NULL,
  "close_time_utc" time NOT NULL,
  "active" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "office_hours_day_valid"
    CHECK ("day_of_week" >= 0 AND "day_of_week" <= 6),
  CONSTRAINT "office_hours_time_chk"
    CHECK ("close_time_utc" > "open_time_utc")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "office_hours_day_idx"
  ON "resupply"."office_hours" ("day_of_week");
--> statement-breakpoint

-- Seed the editable "office hours" message template (SMS + email). Idempotent
-- (ON CONFLICT DO NOTHING) so a re-run is a no-op and a hand-edited row is
-- never clobbered. Seeding the row makes the template appear in the Message
-- Templates admin page for editing, and lets the closure/blackout auto-reply
-- pre-fill from it. message_templates is created in 0067 (lower prefix, so it
-- always exists by the time this runs).
INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_text", "allowed_variables", "is_active")
VALUES
  ('office_hours', 'sms', NULL,
   'Our office hours are Monday-Friday, 9 AM to 5 PM. We are closed on weekends and holidays and will reply when we reopen. Reply STOP to opt out.',
   '[]'::jsonb, true)
ON CONFLICT ("template_key", "channel") DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active")
VALUES
  ('office_hours', 'email', 'Our office hours',
   '<p>Our office hours are <strong>Monday&ndash;Friday, 9:00 AM&ndash;5:00 PM</strong>.</p><p>We are closed on weekends and holidays. We will get back to you during business hours.</p>',
   'Our office hours are Monday-Friday, 9:00 AM-5:00 PM. We are closed on weekends and holidays. We will get back to you during business hours.',
   '[]'::jsonb, true)
ON CONFLICT ("template_key", "channel") DO NOTHING;
