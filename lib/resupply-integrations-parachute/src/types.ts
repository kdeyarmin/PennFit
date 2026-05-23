// Typed shape produced by parse-order.ts. Persisted into
// inbound_referral_orders.raw_parsed_json after normalisation.
//
// The wire payload Parachute sends is partner-gated (no public
// docs), so this shape encodes "what every DME-ordering webhook
// reasonably carries" + what their marketing material describes.
// Treat any field not present in a real payload as `null` rather
// than throwing — the parser is strict on shape but lenient on
// optionality.

export interface ParachuteHcpcsLine {
  /** HCPCS / HCPCS-II code, e.g. "E0601". */
  code: string;
  /** Up to four billing modifiers, in order. */
  modifiers: string[];
  /** Order quantity as the clinician entered it. */
  quantity: number;
  /** Free-form description as the source presented it. */
  description: string | null;
}

export interface ParachuteDocument {
  /** Stable id within the source — used for dedupe. */
  sourceDocumentId: string;
  /**
   * Free-form kind. Common values: prescription, face_to_face,
   * sleep_study, chart_note, cmn, other. Unknown values are
   * preserved verbatim — Phase 2 will surface them in the triage UI.
   */
  kind: string;
  /** Filename as the source presented it. */
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  /** Source-signed CDN URL to fetch the bytes. May expire. */
  sourceUrl: string | null;
}

export interface ParachuteOrder {
  /** Source order id — UNIQUE per source in our DB. */
  sourceOrderId: string;
  /**
   * Source's own event slug — 'order.created' | 'order.updated' |
   * 'order.cancelled' | etc. Preserved verbatim; the dispatcher
   * decides what to do with it.
   */
  eventType: string;
  /** ISO-8601 timestamp the source claims as event creation. */
  occurredAt: string;
  patient: {
    sourcePatientId: string | null;
    firstName: string | null;
    lastName: string | null;
    /** YYYY-MM-DD. */
    dob: string | null;
    phoneE164: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  provider: {
    /** Ordering clinician NPI. */
    npi: string | null;
    firstName: string | null;
    lastName: string | null;
    facilityName: string | null;
  };
  /** Free-form payer name (no canonical id from Parachute). */
  payerName: string | null;
  /** Member id / policy id as the source presented it. */
  memberId: string | null;
  hcpcsLines: ParachuteHcpcsLine[];
  /** Diagnosis codes — strings, not enums (sources vary). */
  icd10Codes: string[];
  documents: ParachuteDocument[];
  /** Free-form CSR-visible note from the ordering clinician. */
  clinicalNote: string | null;
}
