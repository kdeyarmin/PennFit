// shop_back_in_stock_notifications — durable list of patients who
// asked to be emailed when an out-of-stock SKU returns. Created by
// the public POST /shop/back-in-stock route on the product detail
// page when stockCount is 0; fired (best-effort SendGrid + stamp
// notified_at) by the admin /admin/shop/products/:id/stock PATCH
// when the count transitions 0 -> positive.
//
// Dedupe: a partial unique index on (product_id, email) WHERE
// notified_at IS NULL means a single patient can sit on the
// notify-me list at most once per SKU. Once notified, a fresh
// out-of-stock period starts a fresh row.

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export const shopBackInStockNotifications = resupplySchema.table(
  "shop_back_in_stock_notifications",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /** Stripe product id (prod_…). Validated at the API layer. */
    productId: text("product_id").notNull(),
    /** Lowercased + trimmed at submit time. */
    email: text("email").notNull(),
    submitterIp: text("submitter_ip"),
    userAgent: text("user_agent"),
    /** NULL while pending; set when the email was attempted (whether
     *  delivery succeeded or not — see `delivered`). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    delivered: boolean("delivered").notNull().default(false),
    /** SendGrid / EmailApiError message captured for ops triage. */
    deliveryError: text("delivery_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pendingIdx: index("shop_bis_pending_idx")
      .on(t.productId)
      .where(sql`${t.notifiedAt} IS NULL`),
    uniquePendingIdx: uniqueIndex("shop_bis_unique_pending_idx")
      .on(t.productId, t.email)
      .where(sql`${t.notifiedAt} IS NULL`),
    createdIdx: index("shop_bis_created_idx").on(t.createdAt),
  }),
);

export type ShopBackInStockNotification =
  typeof shopBackInStockNotifications.$inferSelect;
export type NewShopBackInStockNotification =
  typeof shopBackInStockNotifications.$inferInsert;
