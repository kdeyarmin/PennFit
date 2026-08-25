// Supply categories for the product catalog.
//
// Successor to the `SHOP_CATEGORIES` list that lived in the Stripe
// products-meta module. It stayed in code rather than moving into a DB
// enum for the same reason the column has no CHECK constraint: the list is
// presentation (filter chips, reorder cadences, the resupply matcher's
// category hint), and a tenant stocking something unusual should not need a
// migration. An unrecognised value round-trips untouched.

export const SUPPLY_CATEGORIES = [
  "mask",
  "cushion",
  "headgear",
  "filter",
  "tubing",
  "humidifier",
  "machine",
  "accessory",
  "other",
] as const;

export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export function isSupplyCategory(v: unknown): v is SupplyCategory {
  return (
    typeof v === "string" &&
    (SUPPLY_CATEGORIES as readonly string[]).includes(v)
  );
}

/**
 * Typical replacement cadence in days, used to seed reorder suggestions.
 * Medicare's standard resupply schedule for the common consumables; a
 * category with no entry has no default cadence and is left to the
 * tenant's own rules.
 */
export const CATEGORY_CADENCE_DAYS: Partial<Record<SupplyCategory, number>> = {
  cushion: 30,
  filter: 14,
  tubing: 90,
  headgear: 180,
  mask: 90,
};

/** Default reorder point when a tracked SKU has no explicit threshold. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
