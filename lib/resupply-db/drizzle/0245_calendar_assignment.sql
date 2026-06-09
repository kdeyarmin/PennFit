-- 0245_calendar_assignment — assign a company-calendar appointment to a
-- staff member.
--
-- Adds an "assigned to" actor (distinct from created_by) so an appointment
-- can be made another team member's responsibility. On assignment the
-- assignee gets a PHI-light email (lib/calendar/appointment-assigned-email.ts)
-- and the event surfaces on their dashboard worklist (/admin/today).
--
-- `text` (not uuid) to match `created_by_user_id` and every sibling actor
-- column (a non-UUID-shaped legacy id must not break an insert). Both
-- nullable — most events are unassigned. `assigned_to_email` is denormalised
-- alongside the id for display + the send, resolved from the staff roster at
-- write time.

ALTER TABLE "resupply"."company_calendar_events"
  ADD COLUMN IF NOT EXISTS "assigned_to_user_id" text;
--> statement-breakpoint

ALTER TABLE "resupply"."company_calendar_events"
  ADD COLUMN IF NOT EXISTS "assigned_to_email" text;
--> statement-breakpoint

-- Partial index for the per-user dashboard read ("appointments assigned to
-- me" — upcoming + scheduled). Only assigned rows are indexed.
CREATE INDEX IF NOT EXISTS "company_calendar_events_assigned_to_idx"
  ON "resupply"."company_calendar_events" ("assigned_to_user_id")
  WHERE "assigned_to_user_id" IS NOT NULL;
