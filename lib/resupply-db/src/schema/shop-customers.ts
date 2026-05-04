// shop_customers — local mirror of "this auth user has a Stripe Customer
// + saved info" for the PennPaps cash-pay shop.
//
// Why a local table at all (Stripe is source of truth for Customers):
//   * /shop/me must answer "what's this user's saved name + address +
//     card brand/last4?" in one DB query — without it we'd hit Stripe
//     on every account-page render.
//   * Order-history queries need a stable foreign key from
//     shop_orders.customer_id back to "the Stripe Customer ID we
//     used for that purchase". Storing the mapping locally avoids
//     a Stripe customer-search per order.
//   * Quick-checkout / one-click reorder needs to find the user's
//     Stripe Customer ID synchronously to attach to a new Session.
//
// What we DO NOT store:
//   * Card numbers, CVCs, full PANs — never. Only display crumbs
//     (brand, last4, exp month/year) so we can render
//     "Visa •••• 4242 — expires 04/29" without a Stripe round-trip.
//   * Billing email — the auth provider owns that. We store
//     `email_lower` only for support lookups + audit; primary
//     identity is `customer_id`.
//
// PK = customer_id: an opaque shop-customer key (sourced from
// `auth.users.id` post-cutover) that is stable for the user's
// lifetime and the natural identifier for every signed-in shop
// request. Using it directly (instead of an auto-generated id)
// eliminates a lookup hop on every /shop/me call.

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

/**
 * Per-customer communication preferences for the cash-pay shop.
 * Every flag is opt-OUT (defaults to true on first account hit) for
 * the transactional channels and opt-IN (defaults to false) for the
 * marketing-style channels. Dispatchers consult this object before
 * sending — see the abandonment-cart and order-tracking helpers.
 */
export interface CommunicationPreferences {
  /** Marketing emails (new product announcements, promotions). */
  emailMarketing: boolean;
  /** Resupply / restock reminder emails. */
  emailResupplyReminders: boolean;
  /** Cart-abandonment recovery emails. */
  emailAbandonedCart: boolean;
  /** Post-purchase review-request emails. */
  emailReviewRequests: boolean;
  /** Marketing SMS. Promotions etc. */
  smsMarketing: boolean;
  /** Transactional SMS (order shipped, delivered). Off by default. */
  smsTransactional: boolean;
  /** Channel preference when both apply (e.g. shipped events). */
  preferredChannel: "email" | "sms";
  /** DND start (0-23, customer's local timezone). null = no DND. */
  dndStartHour: number | null;
  /** DND end (0-23, exclusive). null = no DND. */
  dndEndHour: number | null;
  /** IANA timezone ID for evaluating DND windows server-side. */
  timezone: string | null;
}

export const DEFAULT_COMMUNICATION_PREFERENCES: CommunicationPreferences = {
  emailMarketing: false,
  emailResupplyReminders: true,
  emailAbandonedCart: true,
  emailReviewRequests: true,
  smsMarketing: false,
  smsTransactional: false,
  preferredChannel: "email",
  dndStartHour: null,
  dndEndHour: null,
  timezone: null,
};

/**
 * The customer's CPAP machine, captured on /account so the
 * storefront and customer-service team don't have to ask for it
 * every time. All fields except `manufacturer` and `model` are
 * optional — the shopper may not know their pressure setting or
 * may have intentionally left it off the form.
 *
 * Stored as JSONB so we can add fields (humidifier toggle, ramp
 * setting, mask compatibility hints) without another migration.
 * Migration that introduced the column: 0032.
 */
export interface CpapDeviceInfo {
  manufacturer: string;
  model: string;
  serialNumber?: string | null;
  /** Human-readable, e.g. "8-12 cm H2O" or "10 cm H2O fixed". */
  pressureSetting?: string | null;
  /** Humidifier level if the device supports one, e.g. "3" or "auto". */
  humidifierSetting?: string | null;
  /** Free-form notes the customer wants to share with PennPaps. */
  notes?: string | null;
}

/**
 * The patient's prescribing physician. PHI when bound to the
 * customer's identity — every write through this column goes
 * through `routes/shop/clinical-info.ts` which audit-logs the
 * change with a non-PHI metadata envelope.
 *
 * Mostly optional fields because the rich version (NPI, fax,
 * full address) is only worth filling out when we're actually
 * coordinating prescription verification — the lightweight
 * version (name + phone) is enough to surface to a CSR.
 */
export interface PhysicianInfo {
  name: string;
  practice?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  /** National Provider Identifier — 10-digit NPI for downstream EHR lookups. */
  npi?: string | null;
}

export const shopCustomers = resupplySchema.table(
  "shop_customers",
  {
    customerId: text("customer_id").primaryKey(),
    /**
     * Stripe Customer ID once we've created one. Nullable because the
     * row is created on first /shop/me hit (so we always have a place
     * to persist profile edits) but the Stripe customer is created
     * lazily on the first checkout that involves saving info.
     */
    stripeCustomerId: text("stripe_customer_id").unique(),
    displayName: text("display_name"),
    /**
     * The auth user's primary email at row-creation time,
     * lowercased. Lets support search "what shop customer is
     * anna@example.com?" without a join. Refreshed
     * opportunistically on each /shop/me hit.
     */
    emailLower: text("email_lower"),
    shippingAddress: jsonb(
      "shipping_address_json",
    ).$type<SavedShippingAddress | null>(),
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
    /**
     * Per-customer comm prefs JSONB. Nullable in the DB; the API
     * coalesces missing keys to DEFAULT_COMMUNICATION_PREFERENCES on
     * read so callers can rely on a fully-populated object.
     */
    communicationPreferences: jsonb(
      "communication_preferences",
    ).$type<CommunicationPreferences | null>(),
    /**
     * The customer's CPAP machine — see CpapDeviceInfo above.
     * Migration 0032 added the column. Null when the customer
     * hasn't filled the form out yet.
     */
    cpapDevice: jsonb("cpap_device_json").$type<CpapDeviceInfo | null>(),
    /**
     * The customer's prescribing physician — see PhysicianInfo
     * above. Migration 0032 added the column. PHI; the writing
     * route audit-logs every change with a non-PHI envelope.
     */
    physicianInfo: jsonb("physician_info_json").$type<PhysicianInfo | null>(),
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
