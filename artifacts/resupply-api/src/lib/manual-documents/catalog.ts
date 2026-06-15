// Manual-document type catalog.
//
// A single source of truth — shared by the editable form (the SPA
// fetches it from GET /admin/manual-documents/catalog), the route-layer
// validation, and the PDF renderer — for the document types a staff
// member can author by hand and the fields each one offers.
//
// Design intent: every field starts BLANK and the catalog itself stays
// content-agnostic — it only describes labels + input shapes, never
// default values. Chart-sourced suggestions are an OPT-IN layer on top:
// GET /admin/manual-documents/prefill (routes/admin/manual-documents.ts)
// proposes values from the patient record and the SPA fills only inputs
// the author hasn't typed in, so nothing is ever silently injected.
//
// Pure module — no I/O, no DB, no PHI. Safe to unit-test and to import
// from both the route layer and the PDF renderer.

export type ManualDocumentType =
  | "cmn"
  | "prescription"
  | "agreement"
  | "delivery_ticket"
  | "cover_letter"
  | "other";

export const MANUAL_DOCUMENT_TYPES: readonly ManualDocumentType[] = [
  "cmn",
  "prescription",
  "agreement",
  "delivery_ticket",
  "cover_letter",
  "other",
] as const;

/** Input rendering hint for a single typed field. */
export type ManualDocumentFieldKind = "text" | "textarea" | "date";

export interface ManualDocumentField {
  key: string;
  label: string;
  kind: ManualDocumentFieldKind;
  /** Placeholder shown in the empty input. Never a default value. */
  placeholder?: string;
  /**
   * Render a professional blank line in the PDF even when the stored draft
   * value is empty. This keeps payer-required identifiers visible while the
   * editor input itself remains genuinely blank for chart prefill.
   */
  renderWhenBlank?: boolean;
}

export interface ManualDocumentTypeDef {
  type: ManualDocumentType;
  label: string;
  description: string;
  /**
   * When true the rendered PDF carries the CONFIDENTIAL — HIPAA banner.
   * Clinical document kinds (CMN, prescription, delivery ticket) do;
   * a generic letter or fax cover does not unless the author puts PHI
   * in it (the banner is a default, not a guarantee).
   */
  phi: boolean;
  /** When true the PDF renders a signature + date line at the bottom. */
  requiresSignature: boolean;
  /** Per-type typed fields, in render order. */
  fields: readonly ManualDocumentField[];
}

// The shared recipient block (recipient_name / _address / _email /
// _fax) is modelled as dedicated columns and edited separately from
// `fields`, so it is intentionally NOT part of any type's `fields`.

export const MANUAL_DOCUMENT_CATALOG: readonly ManualDocumentTypeDef[] = [
  {
    type: "cmn",
    label: "Certificate of Medical Necessity",
    description: "Free-form CMN you fill out by hand for a payer or physician.",
    phi: true,
    requiresSignature: true,
    fields: [
      {
        key: "patient_name",
        label: "Patient name",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "date_of_birth",
        label: "Date of birth",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "ordering_physician",
        label: "Ordering physician",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "physician_npi",
        label: "Physician NPI",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "physician_phone",
        label: "Physician phone",
        kind: "text",
        placeholder: "+12155551234",
        renderWhenBlank: true,
      },
      {
        key: "physician_fax",
        label: "Physician fax",
        kind: "text",
        placeholder: "+12155551234",
        renderWhenBlank: true,
      },
      {
        key: "physician_address",
        label: "Physician address",
        kind: "textarea",
        renderWhenBlank: true,
      },
      { key: "diagnosis", label: "Diagnosis / ICD-10", kind: "textarea" },
      { key: "equipment", label: "Equipment / HCPCS", kind: "textarea" },
      { key: "length_of_need", label: "Length of need", kind: "text" },
      {
        key: "clinical_justification",
        label: "Clinical justification",
        kind: "textarea",
      },
    ],
  },
  {
    type: "prescription",
    label: "Prescription / Order",
    description: "A written order you type out for a prescriber to sign.",
    phi: true,
    requiresSignature: true,
    fields: [
      {
        key: "patient_name",
        label: "Patient name",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "date_of_birth",
        label: "Date of birth",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "prescriber_name",
        label: "Prescriber name",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "prescriber_npi",
        label: "Prescriber NPI",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "prescriber_phone",
        label: "Prescriber phone",
        kind: "text",
        placeholder: "+12155551234",
        renderWhenBlank: true,
      },
      {
        key: "prescriber_fax",
        label: "Prescriber fax",
        kind: "text",
        placeholder: "+12155551234",
        renderWhenBlank: true,
      },
      {
        key: "prescriber_address",
        label: "Prescriber address",
        kind: "textarea",
        renderWhenBlank: true,
      },
      { key: "date_of_service", label: "Date of service", kind: "date" },
      { key: "items_ordered", label: "Items ordered", kind: "textarea" },
      { key: "icd10_codes", label: "ICD-10 codes", kind: "text" },
      { key: "directions", label: "Directions / SIG", kind: "textarea" },
      { key: "length_of_need", label: "Length of need", kind: "text" },
    ],
  },
  {
    type: "agreement",
    label: "Agreement / Consent",
    description:
      "A consent or agreement form (financial responsibility, AOB, etc.).",
    phi: false,
    requiresSignature: true,
    fields: [
      {
        key: "party_name",
        label: "Party / patient name",
        kind: "text",
        renderWhenBlank: true,
      },
      { key: "agreement_type", label: "Agreement type", kind: "text" },
      { key: "effective_date", label: "Effective date", kind: "date" },
      { key: "terms", label: "Terms", kind: "textarea" },
    ],
  },
  {
    type: "delivery_ticket",
    label: "Delivery Ticket",
    description: "A proof-of-delivery / itemized delivery ticket.",
    phi: true,
    requiresSignature: true,
    fields: [
      {
        key: "patient_name",
        label: "Patient name",
        kind: "text",
        renderWhenBlank: true,
      },
      {
        key: "delivery_address",
        label: "Delivery address",
        kind: "textarea",
        renderWhenBlank: true,
      },
      {
        key: "delivery_date",
        label: "Delivery date",
        kind: "date",
        renderWhenBlank: true,
      },
      {
        key: "items_delivered",
        label: "Items delivered",
        kind: "textarea",
        renderWhenBlank: true,
      },
      { key: "order_reference", label: "Order reference", kind: "text" },
      { key: "serial_numbers", label: "Serial numbers", kind: "textarea" },
    ],
  },
  {
    type: "cover_letter",
    label: "Fax Cover Letter",
    description: "A cover sheet to send ahead of a fax.",
    phi: false,
    requiresSignature: false,
    fields: [
      { key: "attention", label: "Attention", kind: "text" },
      { key: "from_name", label: "From", kind: "text" },
      { key: "regarding", label: "Regarding", kind: "text" },
      { key: "page_count", label: "Number of pages", kind: "text" },
    ],
  },
  {
    type: "other",
    label: "General Document",
    description: "A free-form letter or document — title and body only.",
    phi: false,
    requiresSignature: false,
    fields: [],
  },
] as const;

const CATALOG_BY_TYPE = new Map<ManualDocumentType, ManualDocumentTypeDef>(
  MANUAL_DOCUMENT_CATALOG.map((def) => [def.type, def]),
);

export function isManualDocumentType(
  value: string,
): value is ManualDocumentType {
  return CATALOG_BY_TYPE.has(value as ManualDocumentType);
}

export function getManualDocumentTypeDef(
  type: ManualDocumentType,
): ManualDocumentTypeDef {
  const def = CATALOG_BY_TYPE.get(type);
  if (!def) {
    // Unreachable when callers gate on isManualDocumentType; throw rather
    // than return a bogus default so a bad type surfaces loudly in tests.
    throw new Error(`Unknown manual document type: ${type}`);
  }
  return def;
}

/** The set of field keys a given type renders. */
export function manualDocumentFieldKeys(type: ManualDocumentType): Set<string> {
  return new Set(getManualDocumentTypeDef(type).fields.map((f) => f.key));
}

/**
 * Strip a raw `fields` object down to only the keys the type defines,
 * coercing values to trimmed strings (and dropping empties). Pure — used
 * by the route layer before persisting and by the renderer before
 * drawing, so the two never disagree on what gets shown.
 */
export function normalizeManualDocumentFields(
  type: ManualDocumentType,
  raw: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const allowed = manualDocumentFieldKeys(type);
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    if (value == null) continue;
    const str = String(value).trim();
    if (str.length === 0) continue;
    out[key] = str;
  }
  return out;
}
