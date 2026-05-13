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
 * csr_shifts — scheduled coverage windows per staff member.
 *
 * Used by the unified CSR "who's on" surface and (Phase B) by
 * the auto-assign helper to skip routing to admins who aren't
 * currently on shift.
 *
 * Posture
 * -------
 *   * One row per discrete shift (a normal 9-5 weekday is one row).
 *   * Times are timestamptz, no recurrence here — recurring weekly
 *     coverage is a separate model (we don't ship that today).
 *   * `status` distinguishes scheduled / called_off / actual.
 *     "actual" rows are stamped by a future clock-in/out feature.
 *
 * Soft FK to admin_users — keep historical rows around if a staffer
 * is removed.
 */
export const csrShifts = resupplySchema.table(
  "csr_shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: text("staff_user_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("scheduled"),
    notes: text("notes"),
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
    staffIdx: index("csr_shifts_staff_idx").on(t.staffUserId, t.startsAt),
    rangeIdx: index("csr_shifts_range_idx").on(t.startsAt, t.endsAt),
    statusEnum: check(
      "csr_shifts_status_enum",
      sql`${t.status} IN ('scheduled','called_off','actual')`,
    ),
    rangeValid: check(
      "csr_shifts_range_valid",
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

export type CsrShiftRow = typeof csrShifts.$inferSelect;
export type InsertCsrShiftRow = typeof csrShifts.$inferInsert;
