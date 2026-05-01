// Stripe Customer ↔ shop customer mapping.
//
// Single entry point: `getOrCreateStripeCustomer(customerId, email,
// displayName?)`. Reads the `shop_customers` row, creates a Stripe
// Customer if we haven't yet, and persists the resulting customer ID
// back to our row.
//
// Idempotency:
//   * Stripe customer creation is wrapped with an `idempotencyKey`
//     scoped to the shop customer ID, so a concurrent retry from
//     the same user doesn't create two Stripe Customers. We then
//     try-insert the mapping locally; if a UNIQUE constraint trips
//     because a parallel call already won the race, we re-read the
//     winning row and return its `stripe_customer_id` instead.
//   * The Stripe Customer's `metadata.customer_id` lets us recover
//     the mapping later (e.g. for ops queries against the Stripe
//     dashboard) without our DB. Pre-cutover Stripe Customers may
//     still carry a legacy `clerk_user_id` metadata key with the
//     same value — readers are expected to fall back to it.
//
// Why we set Customer.email + Customer.metadata.customer_id:
//   * Email gives Stripe Hosted Checkout a prefilled email field —
//     one less thing for the user to type.
//   * The metadata link is the cross-system audit trail: if our DB
//     row gets corrupted, ops can rebuild the mapping from Stripe.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import { getDbPool, shopCustomers, type ShopCustomerRow } from "@workspace/resupply-db";

import { getStripeClient, type StripeConfig } from "./config";

export interface CustomerMapping {
  stripeCustomerId: string;
  row: ShopCustomerRow;
}

/**
 * Ensure the user has a row in `shop_customers` AND a Stripe
 * Customer. Returns the resolved mapping. Safe to call concurrently
 * from multiple checkout attempts.
 */
export async function getOrCreateStripeCustomer(
  config: StripeConfig,
  args: {
    customerId: string;
    email: string | null;
    displayName?: string | null;
  },
): Promise<CustomerMapping> {
  const db = drizzle(getDbPool());
  const stripe = getStripeClient(config);

  // Step 1: ensure a local row exists. The PUT /shop/me path also
  // creates this; we re-create on demand so checkout flows that
  // skip the account page still work.
  const existing = await readRow(db, args.customerId);
  let row: ShopCustomerRow = existing ?? (await insertRow(db, args));

  // Refresh cached email if the auth provider's primary changed since row creation.
  if (args.email && args.email.toLowerCase() !== row.emailLower) {
    row = await updateEmail(db, args.customerId, args.email);
  }

  if (row.stripeCustomerId) {
    return { stripeCustomerId: row.stripeCustomerId, row };
  }

  // Step 2: create a Stripe Customer, idempotency-keyed on the
  // shop customer id. Stripe scopes idempotency to the secret +
  // key, so a double-tap from the same user collapses to one
  // Customer.
  const customer = await stripe.customers.create(
    {
      email: args.email ?? undefined,
      name: args.displayName ?? row.displayName ?? undefined,
      metadata: {
        customer_id: args.customerId,
        source: "pennpaps-shop",
      },
    },
    { idempotencyKey: `pennpaps-shop-customer-${args.customerId}` },
  );

  // Step 3: try to write the mapping. If a sibling request beat us
  // (winning the unique constraint), re-read and prefer the winner —
  // both customers were idempotent-keyed to the same value, so
  // they're the same Stripe Customer anyway.
  try {
    const updated = await db
      .update(shopCustomers)
      .set({
        stripeCustomerId: customer.id,
        updatedAt: new Date(),
      })
      .where(eq(shopCustomers.customerId, args.customerId))
      .returning();
    if (updated[0]) {
      return { stripeCustomerId: customer.id, row: updated[0] };
    }
  } catch {
    /* fall through to re-read */
  }
  const refreshed = await readRow(db, args.customerId);
  if (refreshed?.stripeCustomerId) {
    return { stripeCustomerId: refreshed.stripeCustomerId, row: refreshed };
  }
  // Should be unreachable: we just created the Stripe Customer and
  // either wrote it locally or saw a sibling write. Throw so the
  // caller surfaces a 502 rather than silently dropping the order.
  throw new Error(
    `Failed to persist Stripe customer mapping for customer_id=${args.customerId}`,
  );
}

/** Read-only lookup. Returns null if no row exists yet. */
export async function readShopCustomer(
  customerId: string,
): Promise<ShopCustomerRow | null> {
  const db = drizzle(getDbPool());
  return readRow(db, customerId);
}

/**
 * Upsert a row with no Stripe Customer attached. Used by GET /shop/me
 * to make sure the row exists for first-time visitors so subsequent
 * PUT calls don't have to handle the missing-row case.
 */
export async function ensureShopCustomerRow(args: {
  customerId: string;
  email: string | null;
  displayName?: string | null;
}): Promise<ShopCustomerRow> {
  const db = drizzle(getDbPool());
  const existing = await readRow(db, args.customerId);
  if (existing) {
    if (args.email && args.email.toLowerCase() !== existing.emailLower) {
      return updateEmail(db, args.customerId, args.email);
    }
    return existing;
  }
  return insertRow(db, args);
}

type Db = ReturnType<typeof drizzle>;

async function readRow(
  db: Db,
  customerId: string,
): Promise<ShopCustomerRow | null> {
  const rows = await db
    .select()
    .from(shopCustomers)
    .where(eq(shopCustomers.customerId, customerId))
    .limit(1);
  return rows[0] ?? null;
}

async function insertRow(
  db: Db,
  args: { customerId: string; email: string | null; displayName?: string | null },
): Promise<ShopCustomerRow> {
  const inserted = await db
    .insert(shopCustomers)
    .values({
      customerId: args.customerId,
      emailLower: args.email?.toLowerCase() ?? null,
      displayName: args.displayName ?? null,
    })
    .onConflictDoNothing({ target: shopCustomers.customerId })
    .returning();
  if (inserted[0]) return inserted[0];
  // Conflict — sibling won the insert race. Re-read.
  const refreshed = await readRow(db, args.customerId);
  if (!refreshed) {
    throw new Error(
      `shop_customers row vanished after upsert for customer_id=${args.customerId}`,
    );
  }
  return refreshed;
}

async function updateEmail(
  db: Db,
  customerId: string,
  email: string,
): Promise<ShopCustomerRow> {
  const updated = await db
    .update(shopCustomers)
    .set({ emailLower: email.toLowerCase(), updatedAt: new Date() })
    .where(eq(shopCustomers.customerId, customerId))
    .returning();
  if (!updated[0]) {
    throw new Error(
      `shop_customers update returned no rows for customer_id=${customerId}`,
    );
  }
  return updated[0];
}

/**
 * Pull the latest default payment method off a Stripe Customer and
 * return it in our local-storage shape. Returns null if the customer
 * has no default. Used by the webhook after a successful checkout
 * with `setup_future_usage`.
 */
export async function readDefaultPaymentMethod(
  config: StripeConfig,
  stripeCustomerId: string,
): Promise<{
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
} | null> {
  const stripe = getStripeClient(config);
  const customer = await stripe.customers.retrieve(stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if (customer.deleted) return null;
  const dpm = (customer as Stripe.Customer).invoice_settings
    ?.default_payment_method;
  if (!dpm || typeof dpm === "string") return null;
  if (dpm.type !== "card" || !dpm.card) {
    return { id: dpm.id, brand: null, last4: null, expMonth: null, expYear: null };
  }
  return {
    id: dpm.id,
    brand: dpm.card.brand ?? null,
    last4: dpm.card.last4 ?? null,
    expMonth: dpm.card.exp_month ?? null,
    expYear: dpm.card.exp_year ?? null,
  };
}
