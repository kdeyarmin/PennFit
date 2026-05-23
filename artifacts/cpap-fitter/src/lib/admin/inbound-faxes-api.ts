// Hand-rolled fetch wrapper for /admin/inbound-faxes — the CSR
// triage surface for faxes Twilio delivers to our fax number.

import { ApiError } from "@workspace/api-client-react/admin";

export type InboundFaxStatus = "new" | "triaged" | "attached" | "archived";

export interface InboundFaxListItem {
  id: string;
  twilioFaxSid: string;
  fromE164: string | null;
  toE164: string | null;
  receivedAt: string;
  numPages: number | null;
  hasMedia: boolean;
  mediaContentType: string | null;
  mediaSizeBytes: number | null;
  status: InboundFaxStatus;
  attachedPatientId: string | null;
  attachedProviderId: string | null;
  attachedPrescriptionId: string | null;
  attachedDocumentType: string | null;
  notes: string | null;
  createdAt: string;
  triagedAt: string | null;
}

export interface PatchInboundFaxRequest {
  status?: InboundFaxStatus;
  attachedPatientId?: string | null;
  attachedProviderId?: string | null;
  attachedPrescriptionId?: string | null;
  attachedDocumentType?: string | null;
  notes?: string | null;
}

/**
 * Fetch JSON from an endpoint under the `/resupply-api` prefix and return it as `T`.
 *
 * @param path - The request path appended to `/resupply-api` (e.g. `/admin/...`).
 * @param init - Optional Fetch API init overrides (method, headers, body, etc.).
 * @returns The parsed JSON response as `T`.
 * @throws ApiError when the response has a non-OK HTTP status; the error includes the Response and any parsed JSON body when available.
 */
async function jsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    // Throw ApiError (not plain Error) so <ErrorPanel> can decode the
    // status and render an actionable message — otherwise every
    // failure falls through to the generic "Network error" fallback.
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON — leave data null; ApiError will format from status alone
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export async function listInboundFaxes(
  status: "open" | InboundFaxStatus = "open",
): Promise<{ faxes: InboundFaxListItem[] }> {
  return jsonFetch(
    `/admin/inbound-faxes?status=${encodeURIComponent(status)}`,
  );
}

export async function patchInboundFax(
  id: string,
  body: PatchInboundFaxRequest,
): Promise<{ id: string; changed: boolean }> {
  return jsonFetch(`/admin/inbound-faxes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function inboundFaxMediaUrl(id: string): string {
  return `/resupply-api/admin/inbound-faxes/${encodeURIComponent(id)}/media`;
}
