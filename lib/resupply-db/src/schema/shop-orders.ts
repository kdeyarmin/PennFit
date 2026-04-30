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
//   * Card details — never touched by us; PCI scope stays with
//     Stripe by using Hosted Checkout.
//
// What we DO store (Phase 4 fulfillment columns):
//   * `shipping_address_json` — snapshot of the address used for THIS
//     order. Separate from shop_customers.shipping_address (which is
//     the customer's CURRENT default) so historical orders never
//     change as the customer moves. Captured by the webhook at
//     checkout.session.completed; editable by the customer (and admins)
//     while shipped_at IS NULL.
//   * `tracking_carrier` / `tracking_number` — set by an admin when the
//     parcel ships; surfaces a public Track link on /shop/orders.
//   * `shipped_at` / `delivered_at` — fulfillment timestamps. Modeled
//     as separate columns rather than overloaded onto `status` so the
//     payment lifecycle (`pending`/`paid`/`expired`/`refunded`) and
//     the physical fulfillment lifecycle stay independent. Refunds
//     after shipment preserve the shipped_at timestamp for support.
//
// `status` lifecycle (PAYMENT only — fulfillment is its own dimension):
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
import { index, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";
import type { SavedShippingAddress } from "./shop-customers";

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
    /**
     * auth user ID of the buyer when the checkout was initiated by
     * a signed-in user. Nullable because guest checkout is still
     * supported. Indexed for the order-history query
     * (`/shop/me/orders` filters by this column ordered by
     * created_at DESC). Populated at Session-create time AND
     * re-confirmed by the webhook from Session.metadata.clerk_user_id
     * — defence-in-depth in case the create-time write loses to a
     * crash before commit.
     */
    clerkUserId: text("clerk_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /**
     * Snapshot of the shipping address used for THIS order. Same
     * shape as shop_customers.shipping_address_json so the existing
     * Zod validator + UI form can be reused. Migration 0014.
     */
    shippingAddress: jsonb("shipping_address_json").$type<SavedShippingAddress | null>(),
    /**
     * Carrier name (free-form: "UPS", "USPS", "FedEx", "DHL"). The
     * track-link projection layer maps this to a known URL template;
     * unknown carriers render the bare tracking number with no link.
     * Migration 0013.
     */
    trackingCarrier: text("tracking_carrier"),
    /**
     * Carrier-specific tracking number. Always paired with carrier;
     * the admin endpoint requires both fields so partial state is
     * impossible. Migration 0013.
     */
    trackingNumber: text("tracking_number"),
    /**
     * Set by the admin at the moment they enter tracking. Once non-null
     * the order is no longer in the "awaiting shipment" queue and the
     * customer-facing address-edit endpoint stops accepting writes.
     * Migration 0013.
     */
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    /**
     * Set by an admin (or, in a future iteration, by a carrier-callback
     * worker) once the parcel is delivered. Used for the "delivered"
     * badge on the customer order list and the admin queue counts.
     * Migration 0013.
     */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * One-shot timestamp marking when the post-purchase review-
     * request email went out for this order. NULL = never sent.
     * Migration 0019.
     */
    reviewRequestSentAt: timestamp("review_request_sent_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    statusIdx: index("shop_orders_status_idx").on(t.status),
    createdAtIdx: index("shop_orders_created_at_idx").on(t.createdAt),
    clerkUserIdx: index("shop_orders_clerk_user_id_idx").on(t.clerkUserId),
    // NOTE: Migration 0013 also creates a PARTIAL index
    //   "shop_orders_awaiting_shipment_idx" ON (paid_at DESC)
    //     WHERE shipped_at IS NULL
    // It powers the admin "awaiting shipment" queue. We deliberately
    // do NOT declare it here because Drizzle can't express the WHERE
    // clause; the migration SQL is the source of truth for that
    // index, and query code never names it directly (Postgres
    // chooses it via the planner).
  }),
);

export type ShopOrderRow = typeof shopOrders.$inferSelect;
export type InsertShopOrderRow = typeof shopOrders.$inferInsert;
