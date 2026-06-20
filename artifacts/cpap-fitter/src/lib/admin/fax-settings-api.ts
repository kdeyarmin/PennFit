// Typed fetch wrappers for a tenant's own fax number
// (/admin/organization/fax-settings).
//
// A DME tenant gets its OWN fax number so inbound faxes route to them and
// outbound faxes send from their DID. Numbers are auto-provisioned through
// Telnyx (Twilio retired Programmable Fax) or set manually for a ported /
// pre-existing number. Backed by organizations.fax_from_number (migration
// 0368).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export interface FaxSettings {
  /** The tenant's fax number (E.164), or null when none is set yet. */
  faxNumber: string | null;
  /** Telnyx number-order id the DID came from (null for a manual number). */
  telnyxOrderId: string | null;
  /** When the number was attached to the tenant (ISO), or null. */
  provisionedAt: string | null;
  /** Whether the platform can auto-order a number (Telnyx creds present). */
  canProvision: boolean;
}

export interface ProvisionFaxResult {
  faxNumber: string;
  telnyxOrderId: string;
  provisionedAt: string;
  status: string;
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function sendJSON<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const fetchFaxSettings = () =>
  getJSON<FaxSettings>("/admin/organization/fax-settings");

/** Auto-order a fax-capable DID from Telnyx. Optional area code keeps it local. */
export const provisionFaxNumber = (areaCode?: string) =>
  sendJSON<ProvisionFaxResult>(
    "POST",
    "/admin/organization/fax-settings/provision",
    areaCode ? { areaCode } : {},
  );

/** Manually set (a ported / pre-existing DID) or clear (null) the fax number. */
export const setFaxNumber = (faxNumber: string | null) =>
  sendJSON<{ faxNumber: string | null; provisionedAt: string | null }>(
    "PATCH",
    "/admin/organization/fax-settings",
    { faxNumber },
  );
