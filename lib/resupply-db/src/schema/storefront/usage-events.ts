import { pgTable, text, timestamp, index, uuid } from "drizzle-orm/pg-core";

/**
 * Anonymous funnel-tracking events. NEVER stores IP, user agent, or any
 * patient identifier — just a per-browser-session random id (regenerated
 * each visit) and the funnel step. This lets us answer:
 *   - How many people start a fitting?
 *   - What % drop off at each step?
 *   - Which mask types are most often picked?
 * without ever associating activity to a real person.
 *
 * Allowed step values are validated at the API boundary (zod). DB stays
 * permissive so we can add new steps without a migration.
 */
export const usageEventsTable = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    step: text("step").notNull(),
    metadata: text("metadata"), // tiny JSON string for optional context (e.g. mask_type)
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    occurredAtIdx: index("usage_events_occurred_at_idx").on(t.occurredAt),
    stepIdx: index("usage_events_step_idx").on(t.step),
    sessionIdIdx: index("usage_events_session_id_idx").on(t.sessionId),
  }),
);

export type UsageEventRow = typeof usageEventsTable.$inferSelect;
export type InsertUsageEventRow = typeof usageEventsTable.$inferInsert;
