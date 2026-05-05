// shop_returns — comfort-guarantee swap / refund / RMA tracking.
// See migration 0016_shop_returns.sql for the rationale.

import { sql } from "drizzle-orm";
import { index, integer, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";
import { shopCustomers } from "./shop-customers";
import { shopOrders } from "./shop-orders";

export type ShopReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "shipped_back"
  | "received"
  | "refunded"
  | "replaced"
  | "closed";

export type ShopReturnReason =
  | "fit"
  | "defective"
  | "wrong_item"
  | "no_longer_needed"
  | "other";

export type ShopReturnResolution = "refund" | "exchange" | "store_credit";

export const shopReturns = resupplySchema.table(
  "shop_returns",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    customerId: text("customer_id")
      .notNull()
      .references(() => shopCustomers.customerId, { onDelete: "restrict" }),
    /**
     * The original paid order. ON DELETE RESTRICT — we never let an
     * order be deleted while a return references it (returns are part
     * of the audit / financial trail).
     */
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "restrict" }),
    /**
     * Snapshot of the originating Stripe Checkout Session ID so the
     * customer-side detail page can render "Return for order #abc"
     * without a fresh `shop_orders` join.
     */
    stripeSessionId: text("stripe_session_id").notNull(),
    status: text("status").notNull().default("requested"),
    reason: text("reason").notNull(),
    reasonNote: text("reason_note"),
    resolution: text("resolution"),
    refundCents: integer("refund_cents"),
    stripeRefundId: text("stripe_refund_id"),
    exchangeProductId: text("exchange_product_id"),
    exchangePriceId: text("exchange_price_id"),
    /** New shop_orders row created when an exchange ships. */
    exchangeOrderId: text("exchange_order_id"),
    returnLabelUrl: text("return_label_url"),
    returnCarrier: text("return_carrier"),
    returnTrackingNumber: text("return_tracking_number"),
    /** Free-form admin notes; concatenated, latest first. ≤8KB. */
    adminNote: text("admin_note"),
    /** Last admin who touched the row, for accountability in the queue. */
    adminUserId: text("admin_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    shippedBackAt: timestamp("shipped_back_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    byUserIdx: index("shop_returns_customer_id_idx").on(
      t.customerId,
      t.createdAt,
    ),
    byStatusIdx: index("shop_returns_status_idx").on(t.status, t.createdAt),
    // NOTE: migration 0016 also creates a PARTIAL index
    //   "shop_returns_open_per_order_idx" ON (order_id)
    //     WHERE status IN ('requested','approved','shipped_back','received')
    // Drizzle can't express the WHERE clause; the migration SQL is the
    // source of truth.
  }),
);

export type ShopReturnRow = typeof shopReturns.$inferSelect;
export type InsertShopReturnRow = typeof shopReturns.$inferInsert;

/** Statuses where a return is "open" — admin queue + customer detail. */
export const OPEN_RETURN_STATUSES: ReadonlySet<ShopReturnStatus> = new Set([
  "requested",
  "approved",
  "shipped_back",
  "received",
]);
