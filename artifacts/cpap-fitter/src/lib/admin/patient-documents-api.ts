// Admin-facing client wrappers for patient document endpoints.
// CSRs use these to list, download, and delete documents uploaded by patients.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const API_PREFIX = "/resupply-api";

export interface AdminPatientDocument {
  id: string;
  documentType: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  /** ISO 8601 or null. Null means the document has not been reviewed yet. */
  reviewedAt: string | null;
  reviewedByAdminId: string | null;
  /** Optional free-text note the CSR recorded when marking reviewed. */
  reviewNote: string | null;
}

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  insurance_card: "Insurance card",
  prescription: "Prescription",
  referral: "Referral",
  signed_delivery_ticket: "Signed delivery ticket",
  sleep_study: "Sleep study",
  cmn: "Certificate of Medical Necessity",
  agreement: "Agreement / consent",
  face_to_face: "Face-to-face / chart notes",
  compliance_report: "Compliance report",
  eob: "Explanation of Benefits",
  other: "Other",
};

// The tag options for the scan/upload picker, in dropdown order. Mirrors
// the backend catalog in
// artifacts/resupply-api/src/lib/patient-documents/chart-document-types.ts
// (the server validates against its own copy).
export const CHART_UPLOAD_DOCUMENT_TYPES: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "referral", label: "Referral info" },
  { value: "prescription", label: "Prescription" },
  { value: "signed_delivery_ticket", label: "Signed delivery ticket" },
  { value: "sleep_study", label: "Sleep study" },
  { value: "cmn", label: "Certificate of Medical Necessity" },
  { value: "agreement", label: "Agreement / consent" },
  { value: "face_to_face", label: "Face-to-face / chart notes" },
  { value: "insurance_card", label: "Insurance card" },
  { value: "eob", label: "Explanation of Benefits" },
  { value: "compliance_report", label: "Compliance report" },
  { value: "other", label: "Other" },
];

// Document types that typically represent a signed copy coming back —
// the UI defaults the "mark a pending signature returned" affordance on
// for these. The CSR can still attach a code to any upload.
export const SIGNED_RETURN_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "prescription",
  "signed_delivery_ticket",
  "cmn",
  "agreement",
]);

/** Content types the scan/upload flow accepts (matches the server). */
export const ALLOWED_UPLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadChartDocumentResult {
  id: string;
  signatureMarkedReturned: boolean;
}

/**
 * Scan/upload a file into a patient chart: get a presigned URL, PUT the
 * bytes straight to object storage, then finalize (tag + retention +
 * optional signature-returned). Throws ApiError on any step's failure.
 */
export async function uploadPatientChartDocument(
  patientId: string,
  file: File,
  documentType: string,
  opts?: { signatureTrackingCode?: string },
): Promise<UploadChartDocumentResult> {
  const base = `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents`;
  const contentType = file.type || "application/octet-stream";

  // Step 1 — presigned URL.
  const urlRes = await fetch(`${base}/upload-url`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({
      documentType,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    }),
  });
  if (!urlRes.ok) {
    let data: unknown = null;
    try {
      data = await urlRes.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(urlRes, data, {
      method: "POST",
      url: `${base}/upload-url`,
    });
  }
  const { uploadURL, objectPath } = (await urlRes.json()) as {
    uploadURL: string;
    objectPath: string;
  };

  // Step 2 — PUT the bytes directly to storage (cross-origin; no creds).
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new ApiError(putRes, null, { method: "PUT", url: "object-storage" });
  }

  // Step 3 — finalize.
  const finalizeRes = await fetch(base, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({
      documentType,
      objectPath,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
      ...(opts?.signatureTrackingCode
        ? { signatureTrackingCode: opts.signatureTrackingCode }
        : {}),
    }),
  });
  if (!finalizeRes.ok) {
    let data: unknown = null;
    try {
      data = await finalizeRes.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(finalizeRes, data, { method: "POST", url: base });
  }
  const body = (await finalizeRes.json()) as {
    id: string;
    signatureMarkedReturned: boolean;
  };
  return { id: body.id, signatureMarkedReturned: body.signatureMarkedReturned };
}

export async function listPatientDocuments(
  patientId: string,
): Promise<AdminPatientDocument[]> {
  const url = `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents`;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  const body = (await res.json()) as { documents: AdminPatientDocument[] };
  return body.documents;
}

export function patientDocumentDownloadUrl(
  patientId: string,
  docId: string,
): string {
  return `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(docId)}`;
}

export async function deletePatientDocument(
  patientId: string,
  docId: string,
): Promise<void> {
  const url = `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { ...csrfHeader() },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "DELETE", url });
  }
}

export async function markPatientDocumentReviewed(
  patientId: string,
  docId: string,
  note?: string,
): Promise<{ alreadyReviewed: boolean }> {
  const url = `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(docId)}/reviewed`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(note !== undefined ? { note } : {}),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "PATCH", url });
  }
  const body = (await res.json()) as { ok: true; alreadyReviewed: boolean };
  return { alreadyReviewed: body.alreadyReviewed };
}
