// Chart document-type catalog — the tag options a CSR picks when
// scanning / uploading a document into a patient chart.
//
// This is the staff-facing superset of the patient-portal upload types
// (routes/shop/me-documents.ts). It is the single source of truth the
// admin upload endpoints validate against. The retention horizon for
// each type lives in retention.ts (keyed by the same string value).
//
// Pure module — no I/O, no PHI. Safe to import from the route layer and
// to unit-test.

export interface ChartDocumentType {
  value: string;
  label: string;
}

// Order matters: this is the order the dropdown renders in.
export const CHART_DOCUMENT_TYPES: readonly ChartDocumentType[] = [
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
] as const;

const VALUES = new Set(CHART_DOCUMENT_TYPES.map((t) => t.value));

/** True when `value` is a known chart document type. */
export function isChartDocumentType(value: string): boolean {
  return VALUES.has(value);
}

// Document types that represent a signed copy coming back — uploading
// one of these is the moment a CSR would mark an outstanding signature
// as returned. Used only to default the "mark returned" affordance on;
// the CSR can still mark any upload returned by entering a code.
export const SIGNED_RETURN_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "prescription",
  "signed_delivery_ticket",
  "cmn",
  "agreement",
]);
