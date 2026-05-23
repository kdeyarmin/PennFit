// Hand-rolled fetch wrapper for /admin/inbound-faxes — the CSR
// triage surface for faxes Twilio delivers to our fax number.

import { csrfHeader } from "../csrf";

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

async function jsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(`/resupply-api${path}`, {
    ...restInit,
    headers: { Accept: "application/json", ...csrfHeader(), ...(initHeaders ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
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
