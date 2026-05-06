// shop_customer_push_subscriptions — W3C Web Push registry per
// shop customer (Phase C.1 / feature #4). See migration 0045 for
// the policy doc.
//
// One row per (customer, endpoint). The endpoint is the push
// service URL the browser handed us; storing it as the unique
// natural key lets a re-subscribe overwrite cleanly without
// needing a separate "device id" concept.

import { sql } from "drizzle-orm";
import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";
import { shopCustomers } from "./shop-customers";

export const shopCustomerPushSubscriptions = resupplySchema.table(
  "shop_customer_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id")
      .notNull()
      .references(() => shopCustomers.customerId, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    authB64: text("auth_b64").notNull(),
    p256dhB64: text("p256dh_b64").notNull(),
    userAgent: text("user_agent"),
    /** Set when the push service tells us this subscription is
     *  dead (HTTP 404/410). Dispatcher skips expired rows. */
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    customerActiveIdx: index("shop_customer_push_subscriptions_active_idx").on(
      t.customerId,
    ),
    endpointUnique: unique(
      "shop_customer_push_subscriptions_endpoint_unique",
    ).on(t.endpoint),
  }),
);

export type ShopCustomerPushSubscriptionRow =
  typeof shopCustomerPushSubscriptions.$inferSelect;
export type InsertShopCustomerPushSubscriptionRow =
  typeof shopCustomerPushSubscriptions.$inferInsert;
