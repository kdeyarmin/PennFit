// Admin-facing client wrappers for patient document endpoints.
// CSRs use these to list, download, and delete documents uploaded by patients.

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
  eob: "Explanation of Benefits",
  other: "Other",
};

export async function listPatientDocuments(
  patientId: string,
): Promise<AdminPatientDocument[]> {
  const res = await fetch(
    `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents`,
    { credentials: "same-origin" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load documents (HTTP ${res.status}).`);
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
  const res = await fetch(
    `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE", credentials: "same-origin" },
  );
  if (!res.ok) {
    throw new Error(`Failed to delete document (HTTP ${res.status}).`);
  }
}

export async function markPatientDocumentReviewed(
  patientId: string,
  docId: string,
  note?: string,
): Promise<{ alreadyReviewed: boolean }> {
  const res = await fetch(
    `${API_PREFIX}/patients/${encodeURIComponent(patientId)}/documents/${encodeURIComponent(docId)}/reviewed`,
    {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note !== undefined ? { note } : {}),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to mark document reviewed (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { ok: true; alreadyReviewed: boolean };
  return { alreadyReviewed: body.alreadyReviewed };
}
