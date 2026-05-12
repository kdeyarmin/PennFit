import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * office_recurring_closures — weekly closure pattern (e.g. "we're
 * closed every Sunday"). Separate from office_closures (which is
 * for one-off windows like "Christmas Day 2026") because the
 * recurrence pattern + time-of-day is fundamentally different from
 * an absolute timestamp range.
 *
 * The active-closure helper unions both tables: a recurring rule
 * is active when (now's UTC day matches `day_of_week`) AND
 * (now's UTC time is between start_time_utc and end_time_utc).
 *
 * Tradeoff: we store times in UTC for portability. A 9am–5pm
 * Eastern recurring closure has to be entered as 13:00–21:00 UTC
 * (or 14:00–22:00 during EST). Surveys + ops staff are OK with
 * this trade — the alternative (per-tenant timezone strings) is
 * heavier than the feature needs.
 *
 * Posture
 * -------
 *   * `day_of_week` is 0..6 with 0 = Sunday (matches JS
 *     Date.getUTCDay()).
 *   * No DELETE — toggle `active` instead so audit history
 *     persists.
 */
export const officeRecurringClosures = resupplySchema.table(
  "office_recurring_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 200 }).notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    startTimeUtc: time("start_time_utc").notNull(),
    endTimeUtc: time("end_time_utc").notNull(),
    autoReplyMessage: varchar("auto_reply_message", { length: 320 })
      .notNull(),
    active: integer("active").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    dayIdx: index("office_recurring_closures_day_idx").on(t.dayOfWeek),
    dayValid: check(
      "office_recurring_closures_day_valid",
      sql`${t.dayOfWeek} >= 0 AND ${t.dayOfWeek} <= 6`,
    ),
  }),
);

export type OfficeRecurringClosureRow =
  typeof officeRecurringClosures.$inferSelect;
export type InsertOfficeRecurringClosureRow =
  typeof officeRecurringClosures.$inferInsert;
