// Shop customer rows (`resupply.shop_customers`).
//
// This table predates the insurance-only cutover, when it doubled as the
// Stripe Customer mapping for cash-pay checkout. Card payments are gone —
// patients receive equipment through insurance only — so the Stripe columns
// are no longer written and these helpers are pure DB.
//
// The row still earns its place: it is the per-tenant identity anchor the
// signed-in patient portal hangs off (communication preferences, secure
// messages, clinical info), so `/shop/me*` keeps ensuring it exists on first
// visit.

import {
  getOrgScopedClient,
  type Database,
  type OrgScopedClient,
} from "@workspace/resupply-db";

type ShopCustomerRow = Database["resupply"]["Tables"]["shop_customers"]["Row"];

export async function readShopCustomer(
  customerId: string,
  orgId: string,
): Promise<ShopCustomerRow | null> {
  const oid = orgId?.trim() ?? "";
  if (!oid) {
    // Tenant context missing — treat as "no row" (same null outcome
    // readRow returns when no shop_customers row exists).
    return null;
  }
  return readRow(getOrgScopedClient(oid), customerId);
}

/**
 * Ensure the caller has a `shop_customers` row. Used by GET /shop/me to
 * make sure the row exists for first-time visitors so subsequent PUT
 * calls don't have to handle the missing-row case.
 */
export async function ensureShopCustomerRow(args: {
  /** Tenant the request operates on (req.orgId). Required. */
  orgId: string;
  customerId: string;
  email: string | null;
  displayName?: string | null;
}): Promise<ShopCustomerRow> {
  const orgId = args.orgId?.trim() ?? "";
  if (!orgId) {
    throw new Error("ensureShopCustomerRow: tenant context missing");
  }
  const supabase = getOrgScopedClient(orgId);
  const existing = await readRow(supabase, args.customerId);
  if (existing) {
    if (args.email && args.email.toLowerCase() !== existing.email_lower) {
      return updateEmail(supabase, args.customerId, args.email);
    }
    return existing;
  }
  return insertRow(supabase, args);
}

// These helpers go through the ORG-SCOPED facade (`db.from(...)`), not
// `.raw()`: `shop_customers` is a tenant table with a NOT NULL `org_id`,
// so reads must filter by tenant and the insert MUST carry `org_id`
// (the facade injects it). Using `.raw()` here would both leak across
// tenants and fail the NOT NULL constraint on insert.

async function readRow(
  db: OrgScopedClient,
  customerId: string,
): Promise<ShopCustomerRow | null> {
  const { data, error } = await db
    .from("shop_customers")
    .select("*")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ShopCustomerRow | null) ?? null;
}

async function insertRow(
  db: OrgScopedClient,
  args: {
    customerId: string;
    email: string | null;
    displayName?: string | null;
  },
): Promise<ShopCustomerRow> {
  // PostgREST has no INSERT … ON CONFLICT DO NOTHING; we INSERT and
  // treat 23505 as the "sibling beat us" path, then re-read. `org_id`
  // is injected by the scoped facade.
  const { data: inserted, error: insertErr } = await db
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
    return inserted as ShopCustomerRow;
  }
  const refreshed = await readRow(db, args.customerId);
  if (!refreshed) {
    throw new Error(
      `shop_customers row vanished after upsert for customer_id=${args.customerId}`,
    );
  }
  return refreshed;
}

async function updateEmail(
  db: OrgScopedClient,
  customerId: string,
  email: string,
): Promise<ShopCustomerRow> {
  const { data: updated, error } = await db
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
  return updated as ShopCustomerRow;
}
