// shop_return_notes — internal CSR-authored notes per shop return.
// Mirrors shop_order_notes.ts but keyed on the return. See
// migration 0038 for the policy doc.
//
// Append-only. No `updatedAt`. The dashboard query is always
// "newest first by return", which the (return_id, created_at DESC)
// composite index serves directly from disk.

import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { shopReturns } from "./shop-returns";
import { resupplySchema } from "./_schema";

export const shopReturnNotes = resupplySchema.table(
  "shop_return_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    returnId: text("return_id")
      .notNull()
      .references(() => shopReturns.id, { onDelete: "cascade" }),

    /** Free-text note body. Plain text; CSR-authored decision
     *  rationale on this RMA (approved/denied reason, vendor
     *  response, replacement SKU choice). Never sanitized into
     *  the audit metadata. */
    body: text("body").notNull(),

    /** Who wrote it. Same denormalization rationale as the other
     *  note tables — row stays readable if the admin is later
     *  deleted. */
    authorEmail: text("author_email").notNull(),
    authorUserId: text("author_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    returnCreatedIdx: index("shop_return_notes_return_created_idx").on(
      t.returnId,
      t.createdAt,
    ),
  }),
);

export type ShopReturnNoteRow = typeof shopReturnNotes.$inferSelect;
export type InsertShopReturnNoteRow = typeof shopReturnNotes.$inferInsert;
