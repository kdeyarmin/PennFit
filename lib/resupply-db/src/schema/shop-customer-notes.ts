// shop_customer_notes — internal CSR-authored notes per shop
// customer. Mirrors patient-notes.ts (the equivalent table for the
// resupply patient flow); see migration 0035 for the policy doc.
//
// Append-only. No `updatedAt`. The dashboard query is always
// "newest first by customer", which the (customer_id, created_at)
// composite index serves directly from disk (Postgres uses a
// backward index scan to satisfy the DESC ordering efficiently).

import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { shopCustomers } from "./shop-customers";
import { resupplySchema } from "./_schema";

export const shopCustomerNotes = resupplySchema.table(
  "shop_customer_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id")
      .notNull()
      .references(() => shopCustomers.customerId, { onDelete: "cascade" }),

    /** Free-text note body. Plain text; no PHI policy here — these
     *  are CSR-authored internal notes that may contain anything
     *  the CSR needs to remember. The audit log records the write,
     *  but the body is NOT sanitized into the audit metadata. */
    body: text("body").notNull(),

    /** Who wrote it. Denormalized from the auth provider; same
     *  rationale as `audit_log.admin_email` / `audit_log.admin_user_id`
     *  — the row stays readable if the admin user is later deleted. */
    authorEmail: text("author_email").notNull(),
    authorUserId: text("author_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    customerCreatedIdx: index("shop_customer_notes_customer_created_idx").on(
      t.customerId,
      t.createdAt,
    ),
  }),
);

export type ShopCustomerNoteRow = typeof shopCustomerNotes.$inferSelect;
export type InsertShopCustomerNoteRow = typeof shopCustomerNotes.$inferInsert;
