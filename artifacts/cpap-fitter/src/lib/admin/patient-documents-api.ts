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
