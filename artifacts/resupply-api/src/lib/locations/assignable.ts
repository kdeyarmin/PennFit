// Shared guard for assigning a row (patient, staff member, …) to a
// business location. Multi-location (owner #O1) keeps billing identity
// shared at the org level, so a `location_id` is purely an operational
// anchor — but it must still reference a REAL, ACTIVE location, or the
// branch filters and per-branch views would silently break on a dangling
// or deactivated id.
//
// Returns a discriminated result the route layer maps to a 422 so the
// SPA can show an actionable message ("that location was deactivated")
// instead of a generic failure. A null/absent id is the caller's
// concern (clearing an assignment is always allowed) — this only runs
// for a concrete id.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export type LocationAssignmentCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "not_found" | "inactive" };

/**
 * Verify `locationId` references a location that exists and is active.
 * Deactivated locations are rejected so a row can't be parked on a
 * branch that's been retired (existing assignments to it are left
 * untouched — only NEW assignments are blocked).
 */
export async function assertAssignableLocation(
  supabase: Supabase,
  locationId: string,
): Promise<LocationAssignmentCheck> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("locations")
    .select("id, name, is_active")
    .eq("id", locationId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "not_found" };
  if (!data.is_active) return { ok: false, reason: "inactive" };
  return { ok: true, name: data.name };
}
