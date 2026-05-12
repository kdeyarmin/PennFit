import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { shopOrders } from "./shop-orders";
import { resupplySchema } from "./_schema";

/**
 * shop_order_loss_claims — lost-shipment escalation lifecycle for a
 * paid order whose parcel never arrived.
 *
 * Why a dedicated table
 * ---------------------
 * shop_orders already carries the timestamps of every happy-path
 * milestone (paid_at, shipped_at, delivered_at). The lost-parcel
 * story is a separate workflow that may span weeks of back-and-forth
 * with the carrier — it needs its own audit-grade history rather
 * than being squeezed into a flag on the order. A patient might also
 * legitimately open more than one claim (e.g. a reshipped order goes
 * missing too) — separate rows handle that without contortion.
 *
 * State machine
 * -------------
 *   open                  — patient/CSR has reported non-delivery.
 *                           No carrier action yet.
 *   carrier_filed         — CSR has filed a trace/claim with the
 *                           carrier; carrier_claim_number set.
 *   resolved_refunded     — terminal: claim closed, refund issued
 *                           through the Stripe refund flow.
 *   resolved_reshipped    — terminal: claim closed, a replacement
 *                           order was shipped.
 *   closed_unresolved     — terminal: carrier denied / abandoned.
 *
 * Transitions (enforced application-side):
 *   open → carrier_filed
 *   carrier_filed → resolved_refunded | resolved_reshipped | closed_unresolved
 *   open → resolved_refunded | resolved_reshipped       (CSR bypass)
 */
export const shopOrderLossClaims = resupplySchema.table(
  "shop_order_loss_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    openedByUserId: text("opened_by_user_id"),

    status: varchar("status", { length: 32 }).notNull().default("open"),

    carrierClaimNumber: varchar("carrier_claim_number", { length: 64 }),
    resolutionNote: text("resolution_note"),

    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    carrierFiledAt: timestamp("carrier_filed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    orderIdx: index("shop_order_loss_claims_order_idx").on(t.orderId),
    openIdx: index("shop_order_loss_claims_open_idx")
      .on(t.openedAt)
      .where(sql`${t.resolvedAt} IS NULL`),
    statusEnum: check(
      "shop_order_loss_claims_status_enum",
      sql`${t.status} IN (
        'open',
        'carrier_filed',
        'resolved_refunded',
        'resolved_reshipped',
        'closed_unresolved'
      )`,
    ),
  }),
);

export type ShopOrderLossClaimRow = typeof shopOrderLossClaims.$inferSelect;
export type InsertShopOrderLossClaimRow =
  typeof shopOrderLossClaims.$inferInsert;
