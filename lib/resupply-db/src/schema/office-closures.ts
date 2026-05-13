import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * office_closures — admin-curated windows during which the office
 * is closed (federal holidays, severe-weather closures, all-hands
 * offsites). Inbound SMS that lands during an active window gets
 * an auto-reply with the closure message, and the admin UI renders
 * a banner so CSRs see "we're in a closure right now."
 *
 * Posture
 * -------
 *   * One row per closure event — a "Christmas Day" closure and a
 *     "weather closure on Jan 15" are separate rows.
 *   * `starts_at` / `ends_at` are timestamptz; active = now()
 *     between the two bounds (inclusive lower, exclusive upper).
 *   * `auto_reply_message` is the body the inbound-SMS handler
 *     replies with. Capped at 320 chars (two SMS segments).
 *   * No DELETE in normal flow — past closures stay for audit.
 *     A CSR can early-end a closure by setting ends_at = now().
 */
export const officeClosures = resupplySchema.table(
  "office_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 200 }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    autoReplyMessage: varchar("auto_reply_message", { length: 320 })
      .notNull(),
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
    // Hot path: "find the active closure right now." Partial index
    // would be cleaner but range predicates can't sit in a partial-
    // index WHERE — a plain ends_at index is good enough since
    // there's usually one ~upcoming closure at a time.
    endsAtIdx: index("office_closures_ends_at_idx").on(t.endsAt),
    rangeValid: check(
      "office_closures_range_valid",
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

export type OfficeClosureRow = typeof officeClosures.$inferSelect;
export type InsertOfficeClosureRow = typeof officeClosures.$inferInsert;
