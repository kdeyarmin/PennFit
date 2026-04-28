// shop_orders — local mirror of Stripe Checkout Sessions for the
// PennPaps cash-pay shop.
//
// Why store anything locally at all (Stripe is source of truth):
//   * Audit + analytics ("how many shop orders this month") shouldn't
//     require a Stripe API call — the dashboard should be able to
//     answer aggregate questions over our own DB.
//   * The success page (/shop/checkout-success?session_id=...) needs
//     a quick "is this a real session" check before it spends a
//     network round-trip on Stripe's API; the local row gives us that
//     in one indexed lookup.
//   * Future fulfillment workflow: warehouse ops needs a queue of
//     "paid, awaiting shipment" orders. That queue lives here, not
//     in Stripe.
//
// What we DO NOT store:
//   * Line items — Stripe stores them on the Session. We re-fetch on
//     demand for the success page (single Stripe API call).
//   * Shipping address — Stripe collects it during Checkout and we
//     read it back from the Session when shipping. Avoids duplicate
//     copies of personal data.
//   * Card details — never touched by us; PCI scope stays with
//     Stripe by using Hosted Checkout.
//
// `status` lifecycle:
//   pending  — row created when /shop/checkout creates the Session.
//              Stripe hasn't redirected the user yet.
//   paid     — checkout.session.completed webhook landed.
//   expired  — checkout.session.expired webhook landed (24h timeout).
//   refunded — charge.refunded webhook landed.
//
// `stripe_session_id` is unique — the same client retry hitting
// /shop/checkout with the same Idempotency-Key would land on the
// same Session ID, so the upsert is safe.

import { sql } from "drizzle-orm";
import { index, integer, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export const shopOrders = resupplySchema.table(
  "shop_orders",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    stripeSessionId: text("stripe_session_id").notNull().unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    status: text("status").notNull().default("pending"),
    amountTotalCents: integer("amount_total_cents"),
    currency: text("currency"),
    /**
     * Free-form pinned hash of the cart that produced this session
     * (sha256 of stable-json line items). Lets us short-circuit
     * "is this a re-click of the same cart?" without storing
     * line items themselves.
     */
    cartHash: text("cart_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index("shop_orders_status_idx").on(t.status),
    createdAtIdx: index("shop_orders_created_at_idx").on(t.createdAt),
  }),
);

export type ShopOrderRow = typeof shopOrders.$inferSelect;
export type InsertShopOrderRow = typeof shopOrders.$inferInsert;
