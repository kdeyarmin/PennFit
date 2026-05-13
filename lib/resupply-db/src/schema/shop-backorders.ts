import { sql } from "drizzle-orm";
import {
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * shop_backorders — CSR-curated list of SKUs that are currently
 * out of stock at Pacware (our fulfillment partner). Used by the
 * resupply order-flow to trigger substitution: when a prescription's
 * `item_sku` matches an active backorder row, we look up
 * shop_product_substitutes and ship the first available alternative
 * instead.
 *
 * Why a DB row and not a Stripe metadata flag
 * --------------------------------------------
 * Stripe's `stock_count` mirrors the storefront-facing inventory
 * count, but PennFit is NOT the inventory system of record — Pacware
 * is (see scope decision in CLAUDE.md / replit.md). The CSR / ops
 * team finds out about a backorder via a Pacware notification and
 * needs a one-click way to flip the substitution flag on so the
 * NEXT resupply through this SKU automatically picks an alternative.
 * A DB row gives us audit history ("backordered 2026-05-12, cleared
 * 2026-05-19") that a Stripe metadata flip wouldn't.
 *
 * Posture
 * -------
 *   * `sku` is the primary key — one row per SKU. A "currently
 *     backordered" SKU has cleared_at IS NULL; setting cleared_at
 *     ends the backorder window.
 *   * Re-adding a SKU after it's cleared inserts a fresh row
 *     (different id, same sku) — the unique constraint is on
 *     (sku) WHERE cleared_at IS NULL, so historical rows stack up.
 *   * `marked_by_user_id` is the CSR who flipped it on. SOFT FK to
 *     admin_users — we keep the audit history even if the staff
 *     row is later deleted, matching the patient_grievances posture.
 */
export const shopBackorders = resupplySchema.table(
  "shop_backorders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: varchar("sku", { length: 64 }).notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Null while the backorder is still active. Stamped when ops
     *  confirms the SKU is back in stock. */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    notes: text("notes"),
    /** Soft FK — admin_users.id can disappear (rare), the audit
     *  row stays. */
    markedByUserId: text("marked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Hot path: "is THIS sku currently backordered?" — partial
    // unique index lets us assert at most one active row per SKU.
    activeSkuUniqueIdx: index("shop_backorders_active_sku_idx")
      .on(t.sku)
      .where(sql`${t.clearedAt} IS NULL`),
  }),
);

export type ShopBackorderRow = typeof shopBackorders.$inferSelect;
export type InsertShopBackorderRow = typeof shopBackorders.$inferInsert;
