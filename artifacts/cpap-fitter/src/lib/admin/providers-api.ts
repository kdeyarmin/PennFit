// Hand-rolled fetch wrapper for /admin/providers + the NPPES lookup
// proxy. Same pattern as today-api.ts and followups-list-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type ProviderSource = "nppes" | "csr_entry" | "backfill";

export interface ProviderListItem {
  id: string;
  npi: string;
  legalName: string;
  taxonomyCode: string | null;
  phoneE164: string | null;
  faxE164: string | null;
  email: string | null;
  practiceName: string | null;
  source: ProviderSource;
  verifiedAt: string | null;
  createdAt: string;
}

export interface ProviderDetail extends ProviderListItem {
  practiceAddress: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  } | null;
  notes: string | null;
  updatedAt: string;
}

export interface NppesProviderProjection {
  npi: string;
  legalName: string;
  taxonomyCode: string | null;
  phoneE164: string | null;
  faxE164: string | null;
  practiceName: string | null;
  practiceAddress: ProviderDetail["practiceAddress"];
}

export interface CreateProviderRequest {
  npi: string;
  legalName: string;
  taxonomyCode?: string | null;
  phoneE164?: string | null;
  faxE164?: string | null;
  email?: string | null;
  practiceName?: string | null;
  practiceAddress?: ProviderDetail["practiceAddress"];
  notes?: string | null;
  source?: "nppes" | "csr_entry";
}

export interface CreateProviderResponse {
  id: string;
  created: boolean;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    headers: { Accept: "application/json", ...(initHeaders ?? {}) },
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

export async function listProviders(
  query: string = "",
  opts: { limit?: number; offset?: number } = {},
): Promise<{
  providers: ProviderListItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return jsonFetch(`/admin/providers${qs ? `?${qs}` : ""}`);
}

/**
 * Proxy lookup against the public NPPES registry. Failure bodies
 * (thrown as `ApiError.data`):
 *   404 `{ error: "npi_not_found" }`
 *   502 `{ error: "nppes_unavailable", upstreamStatus: number | null,
 *          message: string }` — `message` is operator-facing and safe
 *          to render verbatim.
 */
export async function lookupNppes(npi: string): Promise<{
  provider: NppesProviderProjection;
}> {
  return jsonFetch(`/admin/providers/nppes-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({ npi }),
  });
}

export async function createProvider(
  body: CreateProviderRequest,
): Promise<CreateProviderResponse> {
  return jsonFetch(`/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(body),
  });
}

export interface ProviderCaseloadEntry {
  patientId: string;
  legalFirstName: string | null;
  legalLastName: string | null;
  email: string | null;
  phoneE164: string | null;
  patientStatus: string | null;
  prescriptionId: string;
  prescriptionStatus: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export async function listProviderCaseload(
  providerId: string,
): Promise<{ patients: ProviderCaseloadEntry[] }> {
  return jsonFetch(
    `/admin/providers/${encodeURIComponent(providerId)}/patients`,
  );
}
