// shop_order_notes — internal CSR-authored notes per shop order.
// Mirrors shop_customer_notes.ts but keyed on the order. See
// migration 0037 for the policy doc.
//
// Append-only. No `updatedAt`. The dashboard query is always
// "newest first by order", which the (order_id, created_at DESC)
// composite index serves directly from disk.

import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { shopOrders } from "./shop-orders";
import { resupplySchema } from "./_schema";

export const shopOrderNotes = resupplySchema.table(
  "shop_order_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),

    /** Free-text note body. Plain text; CSR-authored internal notes
     *  about this specific order (delivery escalations, address
     *  corrections, refund context). The audit row records the write
     *  structurally only — never the body. */
    body: text("body").notNull(),

    /** Who wrote it. Denormalized from the auth provider so the row
     *  stays readable if the admin user is later deleted. Same
     *  rationale as `audit_log.admin_email`. */
    authorEmail: text("author_email").notNull(),
    authorUserId: text("author_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    orderCreatedIdx: index("shop_order_notes_order_created_idx").on(
      t.orderId,
      t.createdAt,
    ),
  }),
);

export type ShopOrderNoteRow = typeof shopOrderNotes.$inferSelect;
export type InsertShopOrderNoteRow = typeof shopOrderNotes.$inferInsert;
