// shop_customers — local mirror of "this Clerk user has a Stripe Customer
// + saved info" for the PennPaps cash-pay shop.
//
// Why a local table at all (Stripe is source of truth for Customers):
//   * /shop/me must answer "what's this user's saved name + address +
//     card brand/last4?" in one DB query — without it we'd hit Stripe
//     on every account-page render.
//   * Order-history queries need a stable foreign key from
//     shop_orders.clerk_user_id back to "the Stripe Customer ID we
//     used for that purchase". Storing the mapping locally avoids
//     a Stripe customer-search per order.
//   * Quick-checkout / one-click reorder needs to find the user's
//     Stripe Customer ID synchronously to attach to a new Session.
//
// What we DO NOT store:
//   * Card numbers, CVCs, full PANs — never. Only display crumbs
//     (brand, last4, exp month/year) so we can render
//     "Visa •••• 4242 — expires 04/29" without a Stripe round-trip.
//   * Billing email — Clerk owns that. We store `email_lower` only
//     for support lookups + audit; primary identity is `clerk_user_id`.
//
// PK = clerk_user_id: stable for the user's lifetime in Clerk and
// already the natural identifier for every signed-in shop request.
// Using it directly (instead of an auto-generated id) eliminates a
// lookup hop on every /shop/me call.

import { sql } from "drizzle-orm";
import { index, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * Saved shipping address shape. Stored as JSONB so we can evolve the
 * field set (e.g. add country) without a migration. The PUT /shop/me
 * route validates this with Zod before persisting.
 */
export interface SavedShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

export const shopCustomers = resupplySchema.table(
  "shop_customers",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    /**
     * Stripe Customer ID once we've created one. Nullable because the
     * row is created on first /shop/me hit (so we always have a place
     * to persist profile edits) but the Stripe customer is created
     * lazily on the first checkout that involves saving info.
     */
    stripeCustomerId: text("stripe_customer_id").unique(),
    displayName: text("display_name"),
    /**
     * Clerk's primary email at row-creation time, lowercased. Lets
     * support search "what shop customer is anna@example.com?" without
     * a Clerk Backend API call. Refreshed opportunistically on each
     * /shop/me hit.
     */
    emailLower: text("email_lower"),
    shippingAddress: jsonb("shipping_address_json").$type<SavedShippingAddress | null>(),
    /**
     * Last default payment method we saw on the Stripe Customer.
     * Populated by the webhook on checkout.session.completed when
     * the session saved a card via setup_future_usage. We only ever
     * read these crumbs for display — actual charging always uses
     * the live default on the Stripe Customer at the time the next
     * Session is created.
     */
    defaultPaymentMethodId: text("default_payment_method_id"),
    defaultPaymentMethodBrand: text("default_payment_method_brand"),
    defaultPaymentMethodLast4: text("default_payment_method_last4"),
    defaultPaymentMethodExpMonth: integer("default_payment_method_exp_month"),
    defaultPaymentMethodExpYear: integer("default_payment_method_exp_year"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    emailIdx: index("shop_customers_email_lower_idx").on(t.emailLower),
  }),
);

export type ShopCustomerRow = typeof shopCustomers.$inferSelect;
export type InsertShopCustomerRow = typeof shopCustomers.$inferInsert;
