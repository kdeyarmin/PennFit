// shop_customer_followups — internal CSR-scheduled callback
// reminders per shop customer. See migration 0039 for the policy
// doc and the split rationale vs. shop_customer_notes.
//
// Lifecycle is a one-way transition: open (completed_at IS NULL)
// → completed (completed_at + completed_by populated). No edit /
// delete; revisions are new rows.

import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { shopCustomers } from "./shop-customers";
import { resupplySchema } from "./_schema";

export const shopCustomerFollowups = resupplySchema.table(
  "shop_customer_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id")
      .notNull()
      .references(() => shopCustomers.customerId, { onDelete: "cascade" }),

    /** Free-text reminder body. Plain text — same posture as
     *  shop_customer_notes; never sanitized into audit metadata. */
    body: text("body").notNull(),

    /** When this followup is due. NOT NULL — every followup must
     *  commit to a concrete time so "due soon" / "overdue" queries
     *  are deterministic. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),

    /** Set when a CSR marks the followup complete. Null until then. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByEmail: text("completed_by_email"),
    completedByUserId: text("completed_by_user_id"),

    createdByEmail: text("created_by_email").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    customerDueIdx: index("shop_customer_followups_customer_due_idx").on(
      t.customerId,
      t.dueAt,
    ),
    // The partial "open" index is created by the migration directly
    // (drizzle-kit doesn't express the WHERE clause).
  }),
);

export type ShopCustomerFollowupRow = typeof shopCustomerFollowups.$inferSelect;
export type InsertShopCustomerFollowupRow =
  typeof shopCustomerFollowups.$inferInsert;
