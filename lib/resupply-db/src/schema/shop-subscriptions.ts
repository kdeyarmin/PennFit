// shop_subscriptions — local mirror of Stripe Subscriptions for the
// PennPaps cash-pay shop's "Subscribe & Save" / auto-ship flow.
//
// Why mirror locally (Stripe is source of truth):
//   * The /account "Active subscriptions" panel must render in one
//     indexed lookup — calling stripe.subscriptions.list per user on
//     every page load costs latency we don't need.
//   * Operational reporting ("how many active auto-ships this month")
//     should be answerable from our DB without hitting Stripe.
//   * Webhook-driven sync from customer.subscription.* events keeps
//     this row authoritative-enough for UI; details can always be
//     re-fetched from Stripe on demand.
//
// `status` mirrors Stripe's subscription status verbatim:
//   active, past_due, unpaid, canceled, incomplete, incomplete_expired,
//   trialing, paused.
//
// `items` is a JSONB snapshot of the subscription's line items at the
// last webhook event. Stripe is still the source of truth for billing,
// but storing the snapshot lets the /account UI render line names +
// amounts without an extra Stripe round-trip.
//
// `cancel_at_period_end` is the request flag (set when the patient
// hits "Cancel auto-ship"); `canceled_at` only fills in when Stripe
// actually finalizes the cancellation.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export interface ShopSubscriptionItemSnapshot {
  /** Stripe price ID (recurring). */
  priceId: string;
  /** Stripe product ID. */
  productId: string | null;
  /** Quantity charged per cycle. */
  quantity: number;
  /** Display name from Stripe Product, snapshot at event time. */
  name: string | null;
  /** Per-unit amount in cents at event time. */
  unitAmountCents: number | null;
  /** Currency code at event time. */
  currency: string | null;
  /** Recurring interval label, e.g. "month" or "3 months". */
  intervalLabel: string | null;
}

export const shopSubscriptions = resupplySchema.table(
  "shop_subscriptions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * Shop-customer key of the subscriber. Required — guest
     * subscriptions aren't supported (we need a stable account to
     * manage / cancel). The /shop/checkout endpoint refuses to
     * enter subscription mode for an anonymous cart, so this is
     * never null in practice.
     */
    customerId: text("customer_id").notNull(),
    /**
     * Stripe Subscription ID. Unique — `customer.subscription.created`
     * upserts on this column.
     */
    stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
    /** Stripe Customer ID this subscription bills to. */
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * Mirrors Stripe's subscription `status` field verbatim. See
     * https://stripe.com/docs/api/subscriptions/object#subscription_object-status
     */
    status: text("status", {
      enum: ["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused"],
    }).notNull(),
    /**
     * JSONB snapshot of the subscription's line items at the last
     * webhook event. Used for the /account UI; Stripe stays the source
     * of truth for billing.
     */
    items: jsonb("items")
      .$type<ShopSubscriptionItemSnapshot[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Unix-epoch end of the current billing period, denormalized so
     * the /account UI can render "Next ship: Jun 14" without a Stripe
     * round-trip. Stored as bigint-safe text → integer (Stripe uses
     * 32-bit timestamps everywhere; we have 7 years of headroom).
     */
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /**
     * `true` when the patient has requested cancellation but the
     * subscription is still active until period end.
     */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /**
     * Set by Stripe when the subscription is fully canceled
     * (status = 'canceled' AND cancel finalized).
     */
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /**
     * Stripe's amount_total for the subscription's first invoice,
     * for display in the success page right after checkout. Optional;
     * subsequent invoices may differ.
     */
    initialAmountTotalCents: integer("initial_amount_total_cents"),
    /**
     * Stripe `event.created` timestamp of the most recently applied
     * customer.subscription.* event. Used to guard against stale /
     * out-of-order webhook deliveries: the upsert in
     * webhook-handler.ts only writes when the incoming event is at
     * least as new as this column. Nullable for legacy rows written
     * before this column existed (the first new event always wins
     * for those).
     */
    lastStripeEventAt: timestamp("last_stripe_event_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    customerIdx: index("shop_subscriptions_customer_id_idx").on(t.customerId),
    statusIdx: index("shop_subscriptions_status_idx").on(t.status),
    statusEnum: check(
      "shop_subscriptions_status_enum",
      sql`${t.status} IN ('active','past_due','unpaid','canceled','incomplete','incomplete_expired','trialing','paused')`,
    ),
  }),
);

export type ShopSubscriptionRow = typeof shopSubscriptions.$inferSelect;
export type InsertShopSubscriptionRow = typeof shopSubscriptions.$inferInsert;
