// Pickup-location helpers — the read side of in-store pickup.
//
// "Pickup locations" are the active business branches in
// resupply.locations (migration 0235). The storefront offers them as
// collect-in-store options at checkout; staff resolve them when marking
// an order ready. Inventory is NOT modeled here (Pacware owns stock) —
// a location is just a name + address the customer drives to.
//
// Shared by the public `GET /shop/pickup-locations` route, the checkout
// validator (a chosen pickup location must be an active row), and the
// admin order projection (display the pickup address).

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export interface PickupLocation {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phoneE164: string | null;
  isPrimary: boolean;
}

const LOCATION_COLUMNS =
  "id, name, address_line1, address_line2, city, state, postal_code, phone_e164, is_primary";

function rowToPickupLocation(row: {
  id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone_e164: string | null;
  is_primary: boolean;
}): PickupLocation {
  return {
    id: row.id,
    name: row.name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    phoneE164: row.phone_e164,
    isPrimary: row.is_primary,
  };
}

/**
 * All active business locations, primary first then alphabetical. The
 * storefront presents these as in-store pickup choices.
 */
export async function listActivePickupLocations(): Promise<PickupLocation[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("locations")
    .select(LOCATION_COLUMNS)
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("name", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map(rowToPickupLocation);
}

/**
 * Resolve a single active location by id, or null when it doesn't exist
 * or has been deactivated. Used to validate a chosen pickup location at
 * checkout so a stale / tampered id can't be persisted onto an order.
 */
export async function getActivePickupLocationById(
  id: string,
): Promise<PickupLocation | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("locations")
    .select(LOCATION_COLUMNS)
    .eq("id", id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToPickupLocation(data) : null;
}

/**
 * Resolve several locations by id in one round-trip, keyed by id. Used
 * by the admin/customer order projections to attach the pickup address
 * to a page of orders without N queries. Inactive locations are still
 * returned here (an order may reference a since-retired branch and we
 * still want to show where it was picked up).
 */
export async function getPickupLocationsByIds(
  ids: readonly string[],
): Promise<Map<string, PickupLocation>> {
  const unique = Array.from(new Set(ids.filter((v) => v.length > 0)));
  if (unique.length === 0) return new Map();
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("locations")
    .select(LOCATION_COLUMNS)
    .in("id", unique);
  if (error) throw error;
  const out = new Map<string, PickupLocation>();
  for (const row of data ?? []) out.set(row.id, rowToPickupLocation(row));
  return out;
}
