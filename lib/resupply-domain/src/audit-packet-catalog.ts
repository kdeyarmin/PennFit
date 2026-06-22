// Canonical CPAP/PAP audit-documentation catalog — the selectable items an
// operator can assemble into a single audit-response packet PDF.
// (ADR 008: pure data + selection helpers. No I/O.)
//
// What an auditor asks for
// ------------------------
// For a PAP device (E0601) post-pay review — TPE / RAC / CERT / UPIC, or a
// commercial payer medical-record request — Medicare's documentation set is
// well established (CMS PAP National Coverage + DME MAC PAP Documentation
// Checklists). Insufficient documentation, not medical disagreement, drives
// the large majority of PAP improper payments, so the packet has to be
// complete and self-evidencing. The catalog below is that checklist,
// expressed as selectable line items, each tagged with where its content
// comes from in this system:
//
//   * "on_file"   — a chart document the practice has uploaded/received and
//                   stored (patient_documents); the packet embeds the stored
//                   file(s) of the matching `documentTypes`.
//   * "generated" — a summary this system derives from structured data it
//                   already holds (therapy adherence, claim/billing, dispensed
//                   equipment, resupply contact history); the packet renders
//                   it as a generated page.
//   * "hybrid"    — has both an on-file source and a generated fallback
//                   (e.g. proof of delivery: a signed POD slip if on file,
//                   else a generated shipment/POD record).
//
// The same catalog backs the ADR document checklist (what's outstanding for a
// given request) and the audit-packet builder (what to print at once).

export type AuditItemSource = "on_file" | "generated" | "hybrid";

/** Which kind of PAP audit an item is typically requested for. */
export type AuditScope = "device" | "supplies" | "both";

/** UI grouping for the selection checklist, in print order. */
export type AuditItemGroup =
  | "cover"
  | "order"
  | "clinical"
  | "adherence"
  | "delivery"
  | "authorization"
  | "supplies"
  | "billing";

export interface AuditPacketItem {
  /** Stable key — referenced by the packet-builder request and persisted on
   *  ADR document rows. Never reuse or repurpose a key. */
  key: string;
  /** Short operator-facing label for the checklist. */
  label: string;
  /** What the auditor is asking for / why it's in the set. */
  description: string;
  group: AuditItemGroup;
  source: AuditItemSource;
  /** `patient_documents.document_type` values that satisfy an on_file/hybrid
   *  item. Empty for purely generated items. */
  documentTypes: readonly string[];
  /** Whether the item is part of a device audit, a supplies/resupply audit,
   *  or both. */
  scope: AuditScope;
  /** Pre-checked for a typical PAP device audit packet. */
  defaultForDevice: boolean;
  /** Pre-checked for a typical PAP supplies/resupply audit packet. */
  defaultForSupplies: boolean;
}

/**
 * The catalog. Print order follows array order, which is the order an auditor
 * reads a packet: cover/index → order → clinical necessity → adherence →
 * delivery → authorization/coverage → supplies → billing.
 */
export const AUDIT_PACKET_CATALOG: readonly AuditPacketItem[] = [
  {
    key: "cover_sheet",
    label: "Audit response cover sheet",
    description:
      "Generated index page: supplier name/NPI, beneficiary, claim number(s), dates of service, HCPCS, contractor/ADR reference, and a table of contents for the enclosed documents.",
    group: "cover",
    source: "generated",
    documentTypes: [],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: true,
  },
  {
    key: "swo",
    label: "Standard Written Order (SWO)",
    description:
      "The treating practitioner's order — beneficiary name, item/HCPCS description, order date, prescriber name + NPI, and signature — dated on or before delivery.",
    group: "order",
    source: "on_file",
    documentTypes: ["swo", "prescription", "dwo"],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: true,
  },
  {
    key: "cmn",
    label: "Certificate of Medical Necessity (CMN/DIF)",
    description:
      "Legacy CMN/DIF for claims that predate the SWO-only era. Include when the date of service falls in the CMN period.",
    group: "order",
    source: "on_file",
    documentTypes: ["cmn", "dif"],
    scope: "device",
    defaultForDevice: false,
    defaultForSupplies: false,
  },
  {
    key: "face_to_face_initial",
    label: "Initial face-to-face evaluation",
    description:
      "Treating practitioner's clinical evaluation BEFORE the sleep test documenting OSA signs/symptoms (e.g. Epworth, BMI, neck circumference, daytime sleepiness).",
    group: "clinical",
    source: "on_file",
    documentTypes: ["face_to_face", "office_notes", "medical_records"],
    scope: "device",
    defaultForDevice: true,
    defaultForSupplies: false,
  },
  {
    key: "sleep_study",
    label: "Qualifying sleep study",
    description:
      "Facility polysomnography (PSG) or home sleep apnea test (HSAT) report establishing a qualifying AHI/RDI (≥15, or 5–14 with comorbidities), performed in a Medicare-recognized facility/device.",
    group: "clinical",
    source: "on_file",
    documentTypes: ["sleep_study", "psg", "hsat"],
    scope: "device",
    defaultForDevice: true,
    defaultForSupplies: false,
  },
  {
    key: "reeval_31_91",
    label: "Re-evaluation (day 31–91)",
    description:
      "Treating practitioner's face-to-face re-evaluation no sooner than the 31st and no later than the 91st day of therapy, documenting benefit from PAP and continued use.",
    group: "clinical",
    source: "on_file",
    documentTypes: ["face_to_face", "office_notes", "medical_records"],
    scope: "device",
    defaultForDevice: true,
    defaultForSupplies: false,
  },
  {
    key: "progress_notes",
    label: "Physician progress / chart notes",
    description:
      "Supporting treating-practitioner progress notes and chart records corroborating diagnosis, ongoing need, and continued use.",
    group: "clinical",
    source: "on_file",
    documentTypes: ["medical_records", "office_notes", "progress_notes"],
    scope: "both",
    defaultForDevice: false,
    defaultForSupplies: false,
  },
  {
    key: "compliance_report",
    label: "Adherence / compliance report",
    description:
      "Objective-usage proof showing PAP use ≥4 hours/night on ≥70% of nights over a 30-consecutive-day window within the first 90 days of therapy. Embeds the uploaded device/cloud compliance printout if on file, otherwise a summary generated from device data.",
    group: "adherence",
    source: "hybrid",
    documentTypes: ["compliance_report", "usage_report", "adherence_report"],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: true,
  },
  {
    key: "proof_of_delivery",
    label: "Proof of delivery (POD)",
    description:
      "Signed delivery slip or carrier proof-of-delivery for the device and each accessory — beneficiary/designee signature, item detail, and delivery date. Generated shipment record when no signed slip is on file.",
    group: "delivery",
    source: "hybrid",
    documentTypes: ["proof_of_delivery", "pod"],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: true,
  },
  {
    key: "equipment_detail",
    label: "Dispensed equipment detail",
    description:
      "Generated record of items dispensed: HCPCS, description, serial number, manufacturer, and dispense date — establishing what was billed matches what was delivered.",
    group: "delivery",
    source: "generated",
    documentTypes: [],
    scope: "device",
    defaultForDevice: true,
    defaultForSupplies: false,
  },
  {
    key: "aob",
    label: "Assignment of Benefits (AOB)",
    description:
      "Beneficiary authorization / assignment of benefits on file, signed and dated.",
    group: "authorization",
    source: "on_file",
    documentTypes: ["aob", "assignment_of_benefits", "agreement"],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: false,
  },
  {
    key: "abn",
    label: "Advance Beneficiary Notice (ABN)",
    description:
      "ABN when applicable (non-covered or potentially-denied items) — signed before the item was furnished.",
    group: "authorization",
    source: "on_file",
    documentTypes: ["abn"],
    scope: "both",
    defaultForDevice: false,
    defaultForSupplies: false,
  },
  {
    key: "insurance_card",
    label: "Insurance / coverage documentation",
    description:
      "Copy of the beneficiary's insurance card / coverage record for the date of service.",
    group: "authorization",
    source: "on_file",
    documentTypes: ["insurance_card", "coverage"],
    scope: "both",
    defaultForDevice: false,
    defaultForSupplies: false,
  },
  {
    key: "refill_request",
    label: "Refill request / proof of need",
    description:
      "For resupply: documentation the beneficiary requested or confirmed need for the supplies within the allowed window before dispensing (not auto-shipped without contact).",
    group: "supplies",
    source: "hybrid",
    documentTypes: ["refill_request"],
    scope: "supplies",
    defaultForDevice: false,
    defaultForSupplies: true,
  },
  {
    key: "continued_use",
    label: "Continued use / continued need",
    description:
      "Generated attestation that the beneficiary is still using the device and the supplies remain medically necessary (recent usage or documented contact).",
    group: "supplies",
    source: "generated",
    documentTypes: [],
    scope: "supplies",
    defaultForDevice: false,
    defaultForSupplies: true,
  },
  {
    key: "replacement_schedule",
    label: "Replacement-quantity record",
    description:
      "Generated report of supply replacement dates/quantities against Medicare's usual maximum replacement schedule (e.g. cushions, masks, tubing, filters), showing quantities billed are within policy.",
    group: "supplies",
    source: "generated",
    documentTypes: [],
    scope: "supplies",
    defaultForDevice: false,
    defaultForSupplies: true,
  },
  {
    key: "claim_detail",
    label: "Claim & billing summary",
    description:
      "Generated claim detail: HCPCS, modifiers, dates of service, billed/allowed/paid amounts, and rental month — tying the records to the claim under review.",
    group: "billing",
    source: "generated",
    documentTypes: [],
    scope: "both",
    defaultForDevice: true,
    defaultForSupplies: true,
  },
] as const;

/** All valid catalog keys (closed set). */
export const AUDIT_PACKET_ITEM_KEYS: readonly string[] =
  AUDIT_PACKET_CATALOG.map((i) => i.key);

const BY_KEY = new Map<string, AuditPacketItem>(
  AUDIT_PACKET_CATALOG.map((i) => [i.key, i]),
);

/** Look up a catalog item by key, or `undefined` if not a known key. */
export function getAuditPacketItem(key: string): AuditPacketItem | undefined {
  return BY_KEY.get(key);
}

/** True if `key` is a known catalog item. */
export function isAuditPacketItemKey(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * The default pre-checked selection for a packet, by audit scope. `device`
 * returns the initial-PAP-device set; `supplies` the resupply set; `both`
 * the union (a combined review). Returns keys in catalog (print) order.
 */
export function defaultSelection(scope: AuditScope): string[] {
  return AUDIT_PACKET_CATALOG.filter((i) => {
    if (scope === "device") return i.defaultForDevice;
    if (scope === "supplies") return i.defaultForSupplies;
    return i.defaultForDevice || i.defaultForSupplies;
  }).map((i) => i.key);
}

// ── Audit readiness ────────────────────────────────────────────────────
//
// The audit-critical chart documents whose ABSENCE drives a denial. These are
// the on-file / hybrid items an auditor will not accept a generated summary in
// place of — a signed order, the qualifying study, the face-to-face notes, the
// proof of delivery, the compliance printout, the refill request. Generated
// summaries (cover, equipment, claim, continued-use, replacement) are produced
// by the system and so are never "missing" in the readiness sense.

/** Required chart-document item keys per audit scope. `both` is the union. */
export const REQUIRED_AUDIT_ITEMS: Record<AuditScope, readonly string[]> = {
  device: [
    "swo",
    "face_to_face_initial",
    "sleep_study",
    "reeval_31_91",
    "proof_of_delivery",
    "compliance_report",
  ],
  supplies: ["swo", "proof_of_delivery", "refill_request"],
  both: [
    "swo",
    "face_to_face_initial",
    "sleep_study",
    "reeval_31_91",
    "proof_of_delivery",
    "compliance_report",
    "refill_request",
  ],
};

export interface AuditReadiness {
  scope: AuditScope;
  /** Required item keys for the scope. */
  required: string[];
  /** Required keys that are covered (a chart document is on file). */
  present: string[];
  /** Required keys with no document on file — the audit gaps. */
  missing: string[];
  /** present / required, 0..1 (1 when nothing is required). */
  score: number;
  /** True when no required document is missing. */
  ready: boolean;
}

/**
 * The catalog item keys "covered" for a patient given the document types on
 * file. A generated item is always covered (the system produces it); an
 * on_file/hybrid item is covered when one of its document types is present.
 * Pure — the I/O (reading patient_documents) happens in the caller.
 */
export function coveredKeysFromDocumentTypes(
  documentTypes: readonly string[],
): string[] {
  const present = new Set(documentTypes);
  const covered: string[] = [];
  for (const item of AUDIT_PACKET_CATALOG) {
    if (item.source === "generated") {
      covered.push(item.key);
    } else if (item.documentTypes.some((t) => present.has(t))) {
      covered.push(item.key);
    }
  }
  return covered;
}

/**
 * Assess audit readiness for a scope given the set of item keys that are
 * "covered" — i.e. have a stored chart document on file. Pure. A required item
 * not in `coveredKeys` is a gap an auditor would deny on.
 */
export function assessAuditReadiness(
  scope: AuditScope,
  coveredKeys: readonly string[],
): AuditReadiness {
  const covered = new Set(coveredKeys);
  const required = [...REQUIRED_AUDIT_ITEMS[scope]];
  const present = required.filter((k) => covered.has(k));
  const missing = required.filter((k) => !covered.has(k));
  return {
    scope,
    required,
    present,
    missing,
    score: required.length === 0 ? 1 : present.length / required.length,
    ready: missing.length === 0,
  };
}

export interface NormalizedSelection {
  /** Requested keys that exist in the catalog, in catalog (print) order. */
  items: AuditPacketItem[];
  /** Requested keys that are not in the catalog (ignored). */
  unknown: string[];
}

/**
 * Normalize an operator's requested key list: drop unknowns, de-duplicate,
 * and re-order to catalog/print order so the packet always reads in the
 * order an auditor expects regardless of click order. Pure.
 */
export function normalizeSelection(
  requestedKeys: readonly string[],
): NormalizedSelection {
  const requested = new Set(requestedKeys);
  const unknown = requestedKeys.filter((k) => !BY_KEY.has(k));
  const items = AUDIT_PACKET_CATALOG.filter((i) => requested.has(i.key));
  return { items, unknown };
}
