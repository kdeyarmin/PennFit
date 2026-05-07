// shop_abandoned_carts — server-side mirror of a SIGNED-IN shop
// visitor's localStorage cart, used to drive a single 24h
// "you left items in your cart" SendGrid nudge AND to rehydrate
// the cart on a different device when the patient clicks the
// email link.
//
// One row per shop customer (customer_id is UNIQUE). The frontend
// PUTs the current cart on a 3s debounce; an empty cart issues a
// DELETE that flips `cleared_at` and zeroes `items` (the row stays
// so the dispatcher can record "we already nudged this user once
// for this cart-event" — see remindedAt below).
//
// Suppression rules (enforced by the dispatcher SELECT and by the
// PUT-time reset logic):
//   * `recovered_at IS NOT NULL`  — patient already checked out;
//                                    never nudge again for this cart.
//   * `cleared_at  IS NOT NULL`   — patient explicitly emptied;
//                                    nothing to nudge about.
//   * `reminded_at IS NOT NULL`   — we already sent THIS cart-event's
//                                    one nudge. PUT resets this to
//                                    null when items materially
//                                    change (so a re-fill after a
//                                    long wait can be re-eligible).
//   * `items` length === 0         — nothing to nudge about.
//   * `updated_at > now() - 24h`  — too recent; dispatcher waits.
//
// Privacy: the cart contents (Stripe price/product IDs, names,
// quantities) are PUBLIC catalog data. No PHI lands here. Email is
// denormalized at PUT time so the dispatcher doesn't need to call
// the auth provider per row.

import { sql } from "drizzle-orm";
import { index, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export interface ShopAbandonedCartItem {
  /** Stripe one-time price ID (cart's stable per-line key). */
  priceId: string;
  /** Stripe product ID, for re-linking to the live catalog. */
  productId: string;
  /** Display name from the catalog at snapshot time. */
  name: string;
  /** Quantity (1..20). */
  quantity: number;
  /** Per-unit one-time amount in cents at snapshot time. */
  unitAmountCents: number;
  /** Currency code at snapshot time, lowercase per Stripe convention. */
  currency: string;
  /**
   * "one_time" or "subscription" — preserved across rehydration so
   * the restored cart respects the patient's per-line toggle.
   */
  mode: "one_time" | "subscription";
  /** Recurring (Stripe) price ID, if any. Null for masks. */
  recurringPriceId: string | null;
  /** Pre-rendered cadence label like "month" or "3 months". */
  recurringIntervalLabel: string | null;
  /** Catalog image URL at snapshot time. */
  imageUrl: string | null;
  /** Bundle flag — preserved so the restored cart renders correctly. */
  isBundle: boolean;
}

export const shopAbandonedCarts = resupplySchema.table(
  "shop_abandoned_carts",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * Shop-customer key of the cart owner. Required AND unique —
     * only signed-in patients are tracked (we need an email + a
     * stable identity to send the nudge and to suppress after
     * checkout).
     */
    customerId: text("customer_id").notNull().unique(),
    /**
     * Denormalized destination email (lowercased). Refreshed on
     * every PUT from the auth provider API so the dispatcher can
     * scan in one query without N+1 auth lookups. Nullable for
     * the rare moment between row creation and the first the auth provider
     * fetch succeeding — dispatcher skips null-email rows.
     */
    email: text("email"),
    /**
     * JSONB snapshot of the localStorage cart. Empty array after a
     * DELETE / cleared_at. The dispatcher only sends when items has
     * at least one entry.
     */
    items: jsonb("items")
      .$type<ShopAbandonedCartItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Subtotal in cents at snapshot time, for the email body. */
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    /** Currency code (lowercase) for the snapshot — typically "usd". */
    currency: text("currency").notNull().default("usd"),
    /**
     * Most recent PUT time. The 24h dispatcher window is measured
     * against this — every cart edit pushes the nudge out by another
     * day, which is the desired UX.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
    /**
     * Set when the dispatcher successfully delivered the one nudge
     * for this cart-event. Reset to null by PUT when items change
     * materially (signals a new cart-event after the user came back
     * and edited).
     */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    /**
     * Set by the Stripe webhook (checkout.session.completed) when
     * the user actually converts. Permanent suppression flag — the
     * dispatcher never picks this row again until items change AND
     * a fresh PUT clears recovered_at.
     */
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    /**
     * Set when the user explicitly emptied their cart (DELETE).
     * Suppresses the dispatcher; cleared by the next PUT with
     * non-empty items.
     */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /**
     * Dispatcher scans for `updated_at <= now() - 24h` with predicate
     * filters layered on top — the index is a B-tree on updated_at
     * so the scan is O(log n + matched). customer_id is already
     * unique-indexed (UNIQUE constraint), so no separate index needed.
     */
    updatedAtIdx: index("shop_abandoned_carts_updated_at_idx").on(t.updatedAt),
  }),
);

export type ShopAbandonedCartRow = typeof shopAbandonedCarts.$inferSelect;
export type InsertShopAbandonedCartRow = typeof shopAbandonedCarts.$inferInsert;
