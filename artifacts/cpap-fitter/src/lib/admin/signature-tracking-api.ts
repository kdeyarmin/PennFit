// API client for /admin/signature-tracking — the unified "still out for
// a provider signature" dashboard + the returned-fax barcode lookup.
// Reads need patients.read; mutations need patients.update (enforced
// server-side). Same hand-rolled fetch + csrfHeader pattern as
// prescription-requests-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type SignatureDocumentKind = "prescription_request" | "manual_document";
export type SignatureTrackingStatus =
  | "awaiting_signature"
  | "returned_signed"
  | "canceled";
export type SignatureDeliveryChannel =
  | "none"
  | "fax"
  | "email"
  | "hand_delivery";

export interface SignatureTrackingItem {
  id: string;
  trackingCode: string;
  documentKind: SignatureDocumentKind;
  documentId: string;
  patientId: string | null;
  providerId: string | null;
  patientLabel: string | null;
  providerLabel: string | null;
  practiceName: string | null;
  title: string;
  status: SignatureTrackingStatus;
  deliveryChannel: SignatureDeliveryChannel;
  returnFaxE164: string | null;
  sentCount: number;
  lastSentAt: string | null;
  returnedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Absolute path to the source document's barcoded PDF. */
  documentPdfPath: string;
}

export interface SignatureProviderGroup {
  providerId: string | null;
  label: string;
  practiceName: string | null;
  count: number;
  oldestCreatedAt: string;
}

export interface OutstandingSignaturesResponse {
  count: number;
  byProvider: SignatureProviderGroup[];
  items: SignatureTrackingItem[];
}

const BASE = "/resupply-api/admin/signature-tracking";

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
      ...csrfHeader(),
    },
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

export async function listOutstandingSignatures(params?: {
  status?: SignatureTrackingStatus;
  providerId?: string;
  practiceName?: string;
  kind?: SignatureDocumentKind;
}): Promise<OutstandingSignaturesResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.providerId) qs.set("providerId", params.providerId);
  if (params?.practiceName) qs.set("practiceName", params.practiceName);
  if (params?.kind) qs.set("kind", params.kind);
  const url = qs.toString() ? `${BASE}?${qs.toString()}` : BASE;
  return jsonFetch<OutstandingSignaturesResponse>(url);
}

export async function lookupSignatureByCode(
  code: string,
): Promise<{ item: SignatureTrackingItem }> {
  const url = `${BASE}/lookup?code=${encodeURIComponent(code)}`;
  return jsonFetch<{ item: SignatureTrackingItem }>(url);
}

export async function markSignatureReturned(
  id: string,
): Promise<{ status: SignatureTrackingStatus }> {
  return jsonFetch(`${BASE}/${encodeURIComponent(id)}/mark-returned`, {
    method: "POST",
  });
}

export async function cancelSignatureTracking(
  id: string,
): Promise<{ status: SignatureTrackingStatus }> {
  return jsonFetch(`${BASE}/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

/**
 * Re-dispatch the source document by fax. Routes to the matching
 * per-kind send-fax endpoint so the dashboard can resend without opening
 * the source page. Uses the recipient/return fax already on the document.
 */
export async function resendSignatureDocument(
  item: Pick<SignatureTrackingItem, "documentKind" | "documentId">,
): Promise<{ ok?: boolean; status?: string; vendorRef?: string }> {
  const path =
    item.documentKind === "prescription_request"
      ? `/resupply-api/admin/prescription-requests/${encodeURIComponent(item.documentId)}/send-fax`
      : `/resupply-api/admin/manual-documents/${encodeURIComponent(item.documentId)}/send-fax`;
  return jsonFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
