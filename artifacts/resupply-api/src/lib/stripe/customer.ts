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
//     same value — readers fall back to it to recover historical
//     records created before the in-house auth cutover.
//
// Why we set Customer.email + Customer.metadata.customer_id:
//   * Email gives Stripe Hosted Checkout a prefilled email field —
//     one less thing for the user to type.
//   * The metadata link is the cross-system audit trail: if our DB
//     row gets corrupted, ops can rebuild the mapping from Stripe.

import type Stripe from "stripe";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

import { getStripeClient, type StripeConfig } from "./config";

type ShopCustomerRow = Database["resupply"]["Tables"]["shop_customers"]["Row"];

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
  const supabase = getSupabaseServiceRoleClient();
  const stripe = getStripeClient(config);

  // Step 1: ensure a local row exists. The PUT /shop/me path also
  // creates this; we re-create on demand so checkout flows that
  // skip the account page still work.
  const existing = await readRow(supabase, args.customerId);
  let row: ShopCustomerRow = existing ?? (await insertRow(supabase, args));

  // Refresh cached email if the auth provider's primary changed since row creation.
  if (args.email && args.email.toLowerCase() !== row.email_lower) {
    row = await updateEmail(supabase, args.customerId, args.email);
  }

  if (row.stripe_customer_id) {
    return { stripeCustomerId: row.stripe_customer_id, row };
  }

  // Step 2: create a Stripe Customer, idempotency-keyed on the
  // shop customer id. Stripe scopes idempotency to the secret +
  // key, so a double-tap from the same user collapses to one
  // Customer.
  const customer = await stripe.customers.create(
    {
      email: args.email ?? undefined,
      name: args.displayName ?? row.display_name ?? undefined,
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
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .update({
        stripe_customer_id: customer.id,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", args.customerId)
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (updated) {
      return { stripeCustomerId: customer.id, row: updated };
    }
  } catch {
    /* fall through to re-read */
  }
  const refreshed = await readRow(supabase, args.customerId);
  if (refreshed?.stripe_customer_id) {
    return { stripeCustomerId: refreshed.stripe_customer_id, row: refreshed };
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
  const supabase = getSupabaseServiceRoleClient();
  return readRow(supabase, customerId);
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
  const supabase = getSupabaseServiceRoleClient();
  const existing = await readRow(supabase, args.customerId);
  if (existing) {
    if (args.email && args.email.toLowerCase() !== existing.email_lower) {
      return updateEmail(supabase, args.customerId, args.email);
    }
    return existing;
  }
  return insertRow(supabase, args);
}

async function readRow(
  supabase: ResupplySupabaseClient,
  customerId: string,
): Promise<ShopCustomerRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("*")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function insertRow(
  supabase: ResupplySupabaseClient,
  args: {
    customerId: string;
    email: string | null;
    displayName?: string | null;
  },
): Promise<ShopCustomerRow> {
  // The original SQL path used INSERT … ON CONFLICT
  // (customer_id) DO NOTHING RETURNING. PostgREST has no DO
  // NOTHING; we INSERT and treat 23505 as the "sibling beat us"
  // path, then re-read.
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .insert({
      customer_id: args.customerId,
      email_lower: args.email?.toLowerCase() ?? null,
      display_name: args.displayName ?? null,
    })
    .select("*")
    .limit(1)
    .maybeSingle();
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      // Sibling already inserted the row — fall through to re-read.
    } else {
      throw insertErr;
    }
  } else if (inserted) {
    return inserted;
  }
  const refreshed = await readRow(supabase, args.customerId);
  if (!refreshed) {
    throw new Error(
      `shop_customers row vanished after upsert for customer_id=${args.customerId}`,
    );
  }
  return refreshed;
}

async function updateEmail(
  supabase: ResupplySupabaseClient,
  customerId: string,
  email: string,
): Promise<ShopCustomerRow> {
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      email_lower: email.toLowerCase(),
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", customerId)
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new Error(
      `shop_customers update returned no rows for customer_id=${customerId}`,
    );
  }
  return updated;
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
    return {
      id: dpm.id,
      brand: null,
      last4: null,
      expMonth: null,
      expYear: null,
    };
  }
  return {
    id: dpm.id,
    brand: dpm.card.brand ?? null,
    last4: dpm.card.last4 ?? null,
    expMonth: dpm.card.exp_month ?? null,
    expYear: dpm.card.exp_year ?? null,
  };
}
