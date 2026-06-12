// Hand-rolled fetch wrapper for /admin/referral-reviews — the
// Referral Reviewer: AI-extracted intake from faxed/uploaded referral
// packets, human-reviewed and explicitly accepted into a new patient
// record.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type ReferralReviewStatus =
  | "pending"
  | "extracted"
  | "accepted"
  | "dismissed"
  | "failed"
  | "offline"
  | "unsupported";

export type ReferralSectionType =
  | "sleep_study"
  | "physician_order"
  | "demographics"
  | "insurance_card"
  | "chart_note"
  | "other";

export interface ReferralExtractionAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface ReferralExtractionInsurance {
  payerName: string | null;
  planName: string | null;
  memberId: string | null;
  groupNumber: string | null;
  policyholderName: string | null;
  policyholderRelationship: string | null;
}

export interface ReferralExtractionDocument {
  type: ReferralSectionType;
  pageStart: number;
  pageEnd: number;
  title: string;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ReferralExtraction {
  patient: {
    firstName: string | null;
    lastName: string | null;
    dob: string | null;
    phone: string | null;
    email: string | null;
    address: ReferralExtractionAddress | null;
  };
  insurance: ReferralExtractionInsurance | null;
  secondaryInsurance: ReferralExtractionInsurance | null;
  order: Array<{ description: string; hcpcs: string | null }>;
  sleepStudy: {
    studyDate: string | null;
    studyType: string | null;
    ahi: number | null;
    rdi: number | null;
    odi: number | null;
    totalSleepMinutes: number | null;
    interpretingPhysician: string | null;
  } | null;
  physician: {
    name: string | null;
    npi: string | null;
    phone: string | null;
    fax: string | null;
    clinic: string | null;
  } | null;
  documents: ReferralExtractionDocument[];
  summary: string | null;
  confidence: {
    patient: ConfidenceLevel;
    insurance: ConfidenceLevel;
    order: ConfidenceLevel;
    sleepStudy: ConfidenceLevel;
  };
}

export interface ReferralReview {
  id: string;
  source: "fax" | "upload";
  inboundFaxId: string | null;
  hasMedia: boolean;
  mediaContentType: string | null;
  mediaSizeBytes: number | null;
  status: ReferralReviewStatus;
  extraction: ReferralExtraction | null;
  extractionModel: string | null;
  extractedAt: string | null;
  errorReason: string | null;
  createdPatientId: string | null;
  acceptedAt: string | null;
  dismissedAt: string | null;
  dismissNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralReviewDetail extends ReferralReview {
  faxFromE164: string | null;
}

export interface DuplicateCandidate {
  id: string;
  legalFirstName: string | null;
  legalLastName: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phoneE164: string | null;
  matchedOn: "phone" | "dob_name";
}

export interface AcceptReferralPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  phoneE164?: string | null;
  email?: string | null;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  } | null;
  insurancePayer?: string | null;
}

export interface AcceptReferralInsurance {
  payerName: string;
  planName?: string | null;
  memberId: string;
  groupNumber?: string | null;
  policyholderName?: string | null;
  policyholderRelationship?: "self" | "spouse" | "child" | "other" | null;
}

export interface AcceptReferralRequest {
  patient: AcceptReferralPatient;
  insurance?: AcceptReferralInsurance | null;
  secondaryInsurance?: AcceptReferralInsurance | null;
  documents?: Array<{
    type: ReferralSectionType;
    pageStart: number;
    pageEnd: number;
    title?: string;
  }>;
  confirmDuplicateOverride?: boolean;
}

export interface AcceptReferralResponse {
  patientId: string;
  documentIds: string[];
  warnings: string[];
}

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
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON — ApiError formats from status alone
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export function listReferralReviews(
  status: "open" | "accepted" | "dismissed" | "all" = "open",
): Promise<{ reviews: ReferralReview[] }> {
  return jsonFetch(
    `/admin/referral-reviews?status=${encodeURIComponent(status)}`,
  );
}

export function getReferralReview(id: string): Promise<ReferralReviewDetail> {
  return jsonFetch(`/admin/referral-reviews/${encodeURIComponent(id)}`);
}

export function referralReviewMediaUrl(id: string): string {
  return `/resupply-api/admin/referral-reviews/${encodeURIComponent(id)}/media`;
}

/** Synchronously (re-)run the AI extraction — also the recovery path
 *  for a review stuck `pending` after a failed enqueue. */
export function extractReferralReview(id: string): Promise<ReferralReview> {
  return jsonFetch(
    `/admin/referral-reviews/${encodeURIComponent(id)}/extract`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
}

export function getReferralReviewDuplicates(
  id: string,
): Promise<{ candidates: DuplicateCandidate[] }> {
  return jsonFetch(
    `/admin/referral-reviews/${encodeURIComponent(id)}/duplicates`,
  );
}

/** Accept the referral: creates the patient + coverage rows, splits
 *  the packet into per-section chart PDFs, attaches the source fax.
 *  409 { error: "possible_duplicate", candidates } when the guard
 *  trips and confirmDuplicateOverride wasn't set. */
export function acceptReferralReview(
  id: string,
  body: AcceptReferralRequest,
): Promise<AcceptReferralResponse> {
  return jsonFetch(`/admin/referral-reviews/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function dismissReferralReview(
  id: string,
  note?: string | null,
): Promise<{ id: string; status: "dismissed" }> {
  return jsonFetch(
    `/admin/referral-reviews/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note ?? null }),
    },
  );
}

/** Two-step manual upload: mint a presigned PUT URL, PUT the PDF,
 *  then finalize to open a pending review + enqueue extraction. */
export function getReferralUploadUrl(
  sizeBytes: number,
): Promise<{ uploadURL: string; objectPath: string }> {
  return jsonFetch("/admin/referral-reviews/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: "application/pdf", sizeBytes }),
  });
}

export function createReferralReviewFromUpload(
  objectPath: string,
): Promise<ReferralReview & { enqueued: boolean }> {
  return jsonFetch("/admin/referral-reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectPath }),
  });
}
