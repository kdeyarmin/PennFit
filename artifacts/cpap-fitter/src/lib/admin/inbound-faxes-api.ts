// Hand-rolled fetch wrapper for /admin/inbound-faxes — the CSR
// triage surface for faxes Telnyx delivers to our fax number.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type InboundFaxStatus = "new" | "triaged" | "attached" | "archived";

/** Outcome of the inbound-fax barcode auto-file attempt (migration 0258).
 *  Null when the `fax.auto_file_signed` flag is off or no scan ran. */
export type AutoFileStatus =
  | "filed"
  | "no_code"
  | "no_match"
  | "already_returned"
  | "no_patient"
  | "failed"
  | "unsupported"
  | "offline";

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
  trackingCodeDetected: string | null;
  autoFileStatus: AutoFileStatus | null;
  autoFiledAt: string | null;
  signatureTrackingId: string | null;
  chartDocumentId: string | null;
  /** Linked Referral Reviewer entry, when the `fax.referral_review`
   *  flag opened one for this fax. */
  referralReviewId: string | null;
  referralReviewStatus: string | null;
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
async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
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
  return jsonFetch(`/admin/inbound-faxes?status=${encodeURIComponent(status)}`);
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

export type FaxOcrStatus = "extracted" | "failed" | "unsupported" | "offline";

export interface FaxOcrLineItem {
  description: string;
  hcpcs: string | null;
}

export interface FaxOcrFields {
  documentType:
    | "prescription"
    | "sleep_study"
    | "chart_note"
    | "face_to_face"
    | "other"
    | null;
  patientName: string | null;
  patientDob: string | null;
  patientPhone: string | null;
  physicianName: string | null;
  physicianNpi: string | null;
  items: FaxOcrLineItem[];
  summary: string | null;
  confidence: "high" | "medium" | "low";
}

export interface RunFaxOcrResponse {
  id: string;
  status: FaxOcrStatus;
  fields: FaxOcrFields | null;
}

/** Run AI field-extraction on a fax. 200 even when the model is offline
 *  ({ status: "offline", fields: null }) — the CSR then keys by hand. */
export async function runFaxOcr(id: string): Promise<RunFaxOcrResponse> {
  return jsonFetch(`/admin/inbound-faxes/${encodeURIComponent(id)}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

export interface AutoFileFaxResponse {
  id: string;
  status: AutoFileStatus;
  trackingCode: string | null;
  chartDocumentId: string | null;
  /** Set when the fax was already auto-filed (no-op re-run). */
  alreadyFiled?: boolean;
}

/** Manually run the barcode auto-file on a fax's stored media — the same
 *  routine the ingest runs on arrival. On a confident match it files the
 *  fax into the patient chart and marks the signature returned; otherwise
 *  it returns the outcome (no_code / no_match / …) for manual triage. */
export async function autoFileInboundFax(
  id: string,
): Promise<AutoFileFaxResponse> {
  return jsonFetch(`/admin/inbound-faxes/${encodeURIComponent(id)}/auto-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}
