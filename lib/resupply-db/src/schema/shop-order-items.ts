// shop_order_items — local mirror of the line items inside each
// paid Stripe Checkout Session.
//
// Why we store line items locally now (we deliberately did NOT before):
//   * The verified-purchaser badge on /shop/p/:productId needs to ask
//     "has this clerk_user_id ever paid for this product_id?" once per
//     review-list page load. Doing that against Stripe per request
//     means an O(reviews-displayed) fanout of API calls — far too
//     expensive. A single indexed `(clerk_user_id, product_id)`
//     lookup on this table answers it in microseconds.
//   * The customer order-history page (/shop/orders) wants to render
//     order line items without paying a separate Stripe call per
//     order in the list.
//
// What we store + lifecycle:
//   * Rows are written by the Stripe webhook handler when a
//     checkout.session moves to `paid`. The handler fetches the
//     Session's line_items (single Stripe API call), then upserts
//     each one. Re-deliveries from Stripe are absorbed by the
//     `(stripe_session_id, product_id, price_id)` UNIQUE index +
//     `onConflictDoNothing()` — webhook idempotency.
//   * `paid_at` is denormalised from shop_orders.paid_at so order-
//     history can sort/page on it without a join.
//   * `clerk_user_id` is denormalised from shop_orders.clerk_user_id
//     for the same reason — and is nullable because guest checkouts
//     are still supported by the rest of the shop pipeline (even
//     though the verified-purchaser badge skips guest rows by design).
//   * No PII is added by this table beyond what shop_orders already
//     stores. Product names are NOT stored — they're rendered at
//     read time from the live Stripe catalog (a renamed product
//     should display its current name in order history).
//
// Pure additive: this table doesn't replace anything in shop_orders.
// shop_orders stays the source of truth for order status, totals,
// and refund lifecycle.

import { sql } from "drizzle-orm";
import { index, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export const shopOrderItems = resupplySchema.table(
  "shop_order_items",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * FK by convention to shop_orders.id (text uuid). Not enforced as
     * a hard FK because the webhook may insert the order row + the
     * items in separate statements and we want neither to depend on
     * the other's commit ordering.
     */
    orderId: text("order_id").notNull(),
    /**
     * Denormalized Stripe Checkout Session id from the parent order.
     * Direct lookup target for "rebuild line items for session X" +
     * the (stripeSessionId, productId, priceId) UNIQUE that
     * idempotents webhook re-deliveries.
     */
    stripeSessionId: text("stripe_session_id").notNull(),
    /**
     * Denormalised buyer Clerk id (mirrors shop_orders.clerk_user_id).
     * Nullable for guest checkouts. Indexed for the verified-
     * purchaser hot path: `WHERE clerk_user_id = $1 AND product_id IN
     * ($2..)` runs as one composite-index lookup.
     */
    clerkUserId: text("clerk_user_id"),
    /** Stripe product id this line item refers to. */
    productId: text("product_id").notNull(),
    /**
     * Stripe price id. Marked NOT NULL with `''` default (migration
     * 0011) so the (stripe_session_id, product_id, price_id) UNIQUE
     * actually dedupes Stripe webhook redeliveries — PostgreSQL
     * UNIQUE treats NULLs as distinct, which would silently allow
     * duplicates for any line item missing a price id.
     *
     * In practice every paid Checkout Session line item carries a
     * price.id; the empty-string sentinel only appears for the
     * defensive "Stripe somehow omitted price.id" fallback in the
     * webhook handler, and even then duplicates are dedup'd.
     */
    priceId: text("price_id").notNull().default(""),
    /** Stripe quantity (defaults to 1 if Stripe omits). */
    quantity: integer("quantity").notNull(),
    /** Per-unit unit_amount from Stripe; nullable when missing. */
    unitAmountCents: integer("unit_amount_cents"),
    /** ISO 4217 currency code, lower-cased per Stripe convention. */
    currency: text("currency"),
    /**
     * paidAt copied from shop_orders.paid_at at insert time so we can
     * order order-history pages by it without a join. Never updated.
     */
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /**
     * Webhook idempotency: a re-delivered checkout.session.completed
     * for the same session must not double-insert the same line item.
     * We key on the Stripe ids (NOT on our internal `order_id`) so
     * the unique check holds even if shop_orders is partitioned by a
     * future schema migration.
     */
    sessionItemUnique: uniqueIndex(
      "shop_order_items_session_product_price_unique",
    ).on(t.stripeSessionId, t.productId, t.priceId),
    /**
     * Verified-purchaser hot path: `WHERE clerk_user_id = $1 AND
     * product_id IN ($2..$N)` runs once per review-list page load.
     * Compound index covers both predicates.
     */
    userProductIdx: index("shop_order_items_clerk_user_id_product_id_idx").on(
      t.clerkUserId,
      t.productId,
    ),
    /** Order-history join target: items by order id. */
    orderIdIdx: index("shop_order_items_order_id_idx").on(t.orderId),
    /** Admin "buyers of product X" / popularity reports. */
    productIdx: index("shop_order_items_product_id_idx").on(t.productId),
  }),
);

export type ShopOrderItemRow = typeof shopOrderItems.$inferSelect;
export type InsertShopOrderItemRow = typeof shopOrderItems.$inferInsert;
