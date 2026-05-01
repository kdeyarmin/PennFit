import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Reminder subscriptions — customers signed up for automated supply
 * replacement reminders (mask cushion, tubing, filters, etc.).
 *
 * Design notes:
 *   - One row per email. Re-subscribing with the same email updates the
 *     existing row (idempotent), reactivating it if previously
 *     unsubscribed.
 *   - `items` is jsonb so we can adjust per-item cadence without
 *     migrations every time we add a new SKU. The shape is documented
 *     in `ReminderItemSchema` (api-zod) and validated by Zod at the
 *     route boundary.
 *   - `manageToken` is a 32-byte hex string used in confirmation /
 *     reminder emails so the customer can self-serve manage / unsubscribe
 *     without re-typing their email. This is the only auth — treat it
 *     as a per-row capability secret.
 *   - `lastSentAt` enforces a quiet period: the dispatcher won't re-send
 *     to the same subscriber within REMINDER_QUIET_PERIOD_DAYS, even if
 *     multiple items become due in that window.
 *   - We deliberately do NOT store the customer's name, address, or
 *     anything else PHI-like. This is a low-stakes opt-in marketing list,
 *     not a PHI-bearing record.
 */
export const reminderSubscriptionsTable = pgTable(
  "reminder_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Lowercased on the way in so the unique index is case-insensitive.
    email: text("email").notNull(),

    // Per-row capability token used in manage / unsubscribe links.
    manageToken: text("manage_token").notNull(),

    // 'active' = receiving reminders. 'unsubscribed' = stopped at the
    // user's request. We keep unsubscribed rows so a re-subscribe with
    // the same email reactivates rather than spawning a duplicate.
    status: text("status", { enum: ["active", "unsubscribed"] })
      .notNull()
      .default("active"),

    // [{ sku, lastReplacedAt: ISO date, intervalDays, nextDueAt: ISO date }]
    items: jsonb("items")
      .notNull()
      .$type<
        Array<{
          sku: string;
          lastReplacedAt: string;
          intervalDays: number;
          nextDueAt: string;
        }>
      >(),

    // When we last sent ANY reminder to this subscriber. Used to enforce
    // a quiet period across all of their items.
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailUniqueIdx: uniqueIndex("reminder_subscriptions_email_unique_idx").on(t.email),
    manageTokenUniqueIdx: uniqueIndex("reminder_subscriptions_manage_token_unique_idx").on(
      t.manageToken,
    ),
    statusIdx: index("reminder_subscriptions_status_idx").on(t.status),
    createdAtIdx: index("reminder_subscriptions_created_at_idx").on(t.createdAt),
  }),
);

export type ReminderSubscriptionRow = typeof reminderSubscriptionsTable.$inferSelect;
export type InsertReminderSubscriptionRow = typeof reminderSubscriptionsTable.$inferInsert;
