// Fetch helpers for /admin/locations — business-location (branch)
// registry (mig 0235). Self-contained fetch wrapper mirroring
// compliance-rules-api. The list endpoint returns RAW snake_case
// columns (it selects straight from PostgREST), so we map to camelCase
// here; create/update accept camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export interface Location {
  id: string;
  name: string;
  code: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phoneE164: string | null;
  npi: string | null;
  isPrimary: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocationCreate {
  name: string;
  code?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phoneE164?: string | null;
  npi?: string | null;
  isPrimary?: boolean;
}

export type LocationUpdate = Partial<LocationCreate> & { isActive?: boolean };

export const LOCATIONS_QUERY_KEY = ["admin", "locations"] as const;
export const LOCATION_ROLLUP_QUERY_KEY = [
  "admin",
  "locations",
  "rollup",
] as const;

/** Per-branch counts. `branches` keyed by location; `unassigned` is the
 *  bucket of patients/staff with no branch set. */
export interface LocationCounts {
  patientCount: number;
  activePatientCount: number;
  staffCount: number;
}
export interface LocationRollupRow extends LocationCounts {
  locationId: string;
  name: string;
  isActive: boolean;
}
export interface LocationRollup {
  branches: LocationRollupRow[];
  unassigned: LocationCounts;
}

const BASE = "/resupply-api/admin/locations";

interface RawLocation {
  id: string;
  name: string;
  code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone_e164: string | null;
  npi: string | null;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapLocation(r: RawLocation): Location {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    phoneE164: r.phone_e164,
    npi: r.npi,
    isPrimary: r.is_primary,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function readError(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function listLocations(): Promise<{
  locations: Location[];
  primaryId: string | null;
}> {
  const res = await fetch(BASE, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await readError(res, "GET", BASE);
  const body = (await res.json()) as {
    locations: RawLocation[];
    primaryId: string | null;
  };
  return {
    locations: (body.locations ?? []).map(mapLocation),
    primaryId: body.primaryId ?? null,
  };
}

export async function getLocationRollup(): Promise<LocationRollup> {
  const url = `${BASE}/rollup`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await readError(res, "GET", url);
  return (await res.json()) as LocationRollup;
}

export async function createLocation(
  data: LocationCreate,
): Promise<{ id: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw await readError(res, "POST", BASE);
  return (await res.json()) as { id: string };
}

export async function updateLocation(
  id: string,
  data: LocationUpdate,
): Promise<void> {
  const url = `${BASE}/${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw await readError(res, "PATCH", url);
}

export function describeLocationError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Couldn't save location.";
  }
  return err instanceof Error ? err.message : "Couldn't save location.";
}
