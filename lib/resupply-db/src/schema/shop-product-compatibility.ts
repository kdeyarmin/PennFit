// shop_product_compatibility — maps Stripe product IDs to the
// CPAP machines they fit (Phase B.3 / feature #11). See migration
// 0044 for the policy doc.
//
// Products with NO rows are treated as universal. machine_model
// can be null to mean "all models from this manufacturer".

import { sql } from "drizzle-orm";
import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export const shopProductCompatibility = resupplySchema.table(
  "shop_product_compatibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: text("product_id").notNull(),
    machineManufacturer: text("machine_manufacturer").notNull(),
    machineModel: text("machine_model"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    productIdx: index("shop_product_compatibility_product_idx").on(t.productId),
    manufacturerIdx: index("shop_product_compatibility_manufacturer_idx").on(
      t.machineManufacturer,
    ),
    productMfrModelUnique: unique("shop_product_compatibility_unique").on(
      t.productId,
      t.machineManufacturer,
      t.machineModel,
    ),
  }),
);

export type ShopProductCompatibilityRow =
  typeof shopProductCompatibility.$inferSelect;
export type InsertShopProductCompatibilityRow =
  typeof shopProductCompatibility.$inferInsert;
