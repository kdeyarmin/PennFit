import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * shop_sku_substitutes — ordered list of alternative SKUs to ship
 * when the primary is backordered. CSR-curated; one entry per
 * (primary, alternative) pair.
 *
 * Lookup contract
 * ---------------
 * When the resupply order-flow finds the prescription's `item_sku`
 * in `shop_backorders` (cleared_at IS NULL), it consults this
 * table for active rows ordered by priority ASC and picks the
 * FIRST alternative_sku that ISN'T itself backordered.
 *
 * Practical example
 * -----------------
 * Mask cushion AF20-S goes out of stock. CSR sets the backorder on
 * AF20-S and adds substitute rows:
 *   (AF20-S, AF20-M, priority=1)   // adjacent size
 *   (AF20-S, AF30-S, priority=2)   // adjacent generation
 *   (AF20-S, P10-S, priority=3)   // alternative platform
 *
 * The next resupply through AF20-S ships AF20-M (priority 1).
 * If AF20-M is also out of stock, the helper moves to priority 2.
 *
 * Posture
 * -------
 *   * (primary_sku, alternative_sku) is UNIQUE — repeated adds
 *     overwrite priority via the upsert path.
 *   * `active` lets CSRs pause a substitute without deleting (the
 *     row keeps its history).
 *   * `priority` is an integer; lower = preferred. Default 100 so
 *     hand-entered rows without a priority sort consistently after
 *     intentionally-ranked entries.
 */
export const shopSkuSubstitutes = resupplySchema.table(
  "shop_sku_substitutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    primarySku: varchar("primary_sku", { length: 64 }).notNull(),
    alternativeSku: varchar("alternative_sku", { length: 64 }).notNull(),
    priority: integer("priority").notNull().default(100),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    primaryAltUnique: uniqueIndex(
      "shop_sku_substitutes_primary_alt_unique",
    ).on(t.primarySku, t.alternativeSku),
    // Hot path: "alternatives for THIS primary, sorted by priority"
    primarySortIdx: index("shop_sku_substitutes_primary_sort_idx").on(
      t.primarySku,
      t.priority,
    ),
  }),
);

export type ShopSkuSubstituteRow = typeof shopSkuSubstitutes.$inferSelect;
export type InsertShopSkuSubstituteRow =
  typeof shopSkuSubstitutes.$inferInsert;
