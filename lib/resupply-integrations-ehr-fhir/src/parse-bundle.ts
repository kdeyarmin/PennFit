// FHIR R4 ServiceRequest Bundle → ParachuteOrder.
//
// EHR partners POST a FHIR `Bundle` with at minimum:
//
//   - ServiceRequest          (the DME order)
//   - Patient                 (subject)
//   - optional Practitioner    (requester)
//   - optional Coverage        (insurance)
//   - optional DocumentReference[]  (Rx, F2F, sleep study)
//   - optional Condition[]    (ICD-10 dx)
//
// We project the Bundle into the same ParachuteOrder shape the
// existing dispatcher pipeline consumes — so matchers, AI classifier,
// triage queue UI, preflight checks all "just work" without
// per-source branches.
//
// We intentionally accept a permissive subset of FHIR. EHRs ship
// inconsistent payloads in the wild (PointClickCare's Coverage
// resource looks nothing like Athena's), and refusing to land an
// order because of a missing-but-not-PHI field is worse than landing
// it and surfacing the gap in the CSR triage queue.
//
// PHI posture: this file processes PHI but never logs it. Errors
// are tagged unions; callers decide what to surface.

import type { ParachuteOrder } from "@workspace/resupply-integrations-parachute";

// Document URLs come from partner-controlled FHIR
// DocumentReference.content.attachment.url and are rendered as an
// `<a href>` on the admin inbound-referrals screen. Allow only
// http:/https: — a `javascript:` / `data:` / `vbscript:` URL would
// otherwise execute in the admin-session origin when an admin clicks
// the link (`rel="noopener noreferrer"` does NOT block `javascript:`).
// Mirrors `httpUrlOrNull` in @workspace/resupply-integrations-parachute,
/**
 * Validates a candidate URL string and returns it only when it uses the HTTP or HTTPS scheme.
 *
 * @param v - Candidate URL value; may be `null` or `undefined`.
 * @returns `v` if it is a non-empty string with an `http` or `https` scheme, `null` otherwise.
 */
function httpUrlOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  try {
    const parsed = new URL(v);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? v
      : null;
  } catch {
    return null;
  }
}

export type ParseBundleOutcome =
  | { ok: true; order: ParachuteOrder }
  | { ok: false; reason: ParseBundleFailure };

export type ParseBundleFailure =
  | "not_a_bundle"
  | "no_service_request"
  | "no_subject_patient"
  | "service_request_missing_id";

interface FhirReference {
  reference?: string;
  identifier?: { value?: string };
}

interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

interface FhirHumanName {
  family?: string;
  given?: string[];
  text?: string;
}

interface FhirContactPoint {
  system?: string;
  value?: string;
}

interface FhirAddress {
  line?: string[];
  city?: string;
  state?: string;
  postalCode?: string;
}

interface FhirIdentifier {
  system?: string;
  value?: string;
}

interface FhirResource {
  resourceType: string;
  id?: string;
  fullUrl?: string;
}

interface FhirServiceRequest extends FhirResource {
  resourceType: "ServiceRequest";
  status?: string;
  intent?: string;
  authoredOn?: string;
  subject?: FhirReference;
  requester?: FhirReference;
  code?: FhirCodeableConcept;
  orderDetail?: FhirCodeableConcept[];
  reasonCode?: FhirCodeableConcept[];
  reasonReference?: FhirReference[];
  insurance?: FhirReference[];
  supportingInfo?: FhirReference[];
  note?: Array<{ text?: string }>;
  quantityQuantity?: { value?: number };
}

interface FhirPatient extends FhirResource {
  resourceType: "Patient";
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  birthDate?: string;
  telecom?: FhirContactPoint[];
  address?: FhirAddress[];
}

interface FhirPractitioner extends FhirResource {
  resourceType: "Practitioner";
  identifier?: FhirIdentifier[]; // NPI lives here
  name?: FhirHumanName[];
}

interface FhirCoverage extends FhirResource {
  resourceType: "Coverage";
  subscriberId?: string;
  payor?: Array<{ display?: string }>;
}

interface FhirCondition extends FhirResource {
  resourceType: "Condition";
  code?: FhirCodeableConcept;
}

interface FhirDocumentReference extends FhirResource {
  resourceType: "DocumentReference";
  type?: FhirCodeableConcept;
  content?: Array<{
    attachment?: {
      url?: string;
      contentType?: string;
      title?: string;
      size?: number;
    };
  }>;
}

interface FhirBundleEntry {
  fullUrl?: string;
  resource?: FhirResource;
}

interface FhirBundle {
  resourceType?: string;
  entry?: FhirBundleEntry[];
}

const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";

/**
 * Parse an inbound FHIR Bundle into a ParachuteOrder suitable for dispatcher consumption.
 *
 * @param input - The parsed JSON value expected to be a FHIR R4 Bundle containing a ServiceRequest and related resources (Patient, optional Practitioner, optional Coverage, DocumentReference[], Condition[]).
 * @returns A ParseBundleOutcome: on success `{ ok: true, order }` where `order` is the projected ParachuteOrder; on failure `{ ok: false, reason }` where `reason` is one of: `"not_a_bundle"`, `"no_service_request"`, `"service_request_missing_id"`, or `"no_subject_patient"`.
 */
export function parseFhirBundle(input: unknown): ParseBundleOutcome {
  if (!isObject(input) || input.resourceType !== "Bundle") {
    return { ok: false, reason: "not_a_bundle" };
  }
  const bundle = input as FhirBundle;
  const entries = bundle.entry ?? [];
  const resources: Record<string, FhirResource[]> = {};
  for (const entry of entries) {
    const r = entry.resource;
    if (!r || typeof r.resourceType !== "string") continue;
    (resources[r.resourceType] ??= []).push(r);
  }

  const sr = (resources.ServiceRequest?.[0] ?? null) as FhirServiceRequest | null;
  if (!sr) return { ok: false, reason: "no_service_request" };
  if (!sr.id) return { ok: false, reason: "service_request_missing_id" };

  const patient = pickReferenced<FhirPatient>(
    resources,
    "Patient",
    sr.subject,
  );
  if (!patient) return { ok: false, reason: "no_subject_patient" };

  const practitioner = pickReferenced<FhirPractitioner>(
    resources,
    "Practitioner",
    sr.requester,
  );
  const coverage = (resources.Coverage?.[0] ?? null) as FhirCoverage | null;
  const conditions =
    (resources.Condition as FhirCondition[] | undefined) ?? [];
  const docs =
    (resources.DocumentReference as FhirDocumentReference[] | undefined) ?? [];

  const sourceOrderId = sr.id;
  const occurredAt =
    typeof sr.authoredOn === "string" && sr.authoredOn.length > 0
      ? sr.authoredOn
      : new Date().toISOString();

  // Patient demographics.
  const primaryName = patient.name?.[0];
  const phone = patient.telecom?.find((t) => t.system === "phone")?.value;
  const email = patient.telecom?.find((t) => t.system === "email")?.value;
  const address = patient.address?.[0];

  // ServiceRequest.code carries the primary HCPCS code; orderDetail
  // can carry additional lines (each with their own code).
  const hcpcsLines = collectHcpcsLines(sr);

  // Conditions → ICD-10 codes.
  const icd10Codes: string[] = [];
  for (const c of conditions) {
    const code = extractIcd10(c.code);
    if (code) icd10Codes.push(code);
  }
  // ServiceRequest.reasonCode can ALSO carry ICD-10 (Athena does
  // this for the primary dx).
  for (const reason of sr.reasonCode ?? []) {
    const code = extractIcd10(reason);
    if (code) icd10Codes.push(code);
  }

  // Provider NPI.
  const npi =
    practitioner?.identifier?.find((i) => i.system === NPI_SYSTEM)?.value ?? null;

  // Documents.
  const documents = docs.map((d): ParachuteOrder["documents"][number] => {
    const content = d.content?.[0]?.attachment;
    const id = d.id ?? `${sourceOrderId}:${d.type?.coding?.[0]?.code ?? "doc"}`;
    return {
      sourceDocumentId: id,
      kind: extractDocKind(d.type),
      filename: content?.title ?? null,
      contentType: content?.contentType ?? null,
      sizeBytes: typeof content?.size === "number" ? content.size : null,
      sourceUrl: httpUrlOrNull(content?.url),
    };
  });

  const order: ParachuteOrder = {
    sourceOrderId,
    eventType: sr.status === "completed" ? "order.completed" : "order.created",
    occurredAt,
    patient: {
      sourcePatientId: patient.id ?? null,
      firstName: primaryName?.given?.[0] ?? null,
      lastName: primaryName?.family ?? null,
      dob: patient.birthDate ?? null,
      phoneE164: normalisePhone(phone),
      email: email ?? null,
      addressLine1: address?.line?.[0] ?? null,
      addressLine2: address?.line?.[1] ?? null,
      city: address?.city ?? null,
      state: address?.state ?? null,
      postalCode: address?.postalCode ?? null,
    },
    provider: {
      npi: normaliseNpi(npi),
      firstName: practitioner?.name?.[0]?.given?.[0] ?? null,
      lastName: practitioner?.name?.[0]?.family ?? null,
      facilityName: null,
    },
    payerName: coverage?.payor?.[0]?.display ?? null,
    memberId: coverage?.subscriberId ?? null,
    hcpcsLines,
    icd10Codes: dedupeUpper(icd10Codes),
    documents,
    clinicalNote: sr.note?.[0]?.text ?? null,
  };
  return { ok: true, order };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function pickReferenced<T extends FhirResource>(
  resources: Record<string, FhirResource[]>,
  type: T["resourceType"],
  ref: FhirReference | undefined,
): T | null {
  const candidates = (resources[type] ?? []) as T[];
  if (candidates.length === 0) return null;
  if (!ref) return candidates[0] ?? null;
  const refStr = ref.reference;
  if (typeof refStr !== "string") return candidates[0] ?? null;
  const refId = refStr.includes("/") ? refStr.split("/")[1] : refStr;
  return (
    candidates.find((c) => c.id === refId || c.fullUrl === refStr) ??
    candidates[0] ??
    null
  );
}

function collectHcpcsLines(sr: FhirServiceRequest): ParachuteOrder["hcpcsLines"] {
  const lines: ParachuteOrder["hcpcsLines"] = [];
  const primary = extractHcpcs(sr.code);
  if (primary) {
    lines.push({
      code: primary.code,
      modifiers: [],
      quantity:
        typeof sr.quantityQuantity?.value === "number"
          ? sr.quantityQuantity.value
          : 1,
      description: primary.description ?? null,
    });
  }
  for (const detail of sr.orderDetail ?? []) {
    const extra = extractHcpcs(detail);
    if (extra && !lines.some((l: ParachuteOrder["hcpcsLines"][number]) => l.code === extra.code)) {
      lines.push({
        code: extra.code,
        modifiers: [],
        quantity: 1,
        description: extra.description ?? null,
      });
    }
  }
  return lines;
}

function extractHcpcs(
  cc: FhirCodeableConcept | undefined,
): { code: string; description: string | null } | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (
      typeof c.code === "string" &&
      /^[A-Z]\d{4}$/i.test(c.code) &&
      (c.system?.includes("hcpcs") || c.system?.includes("HCPCS") || !c.system)
    ) {
      return {
        code: c.code.toUpperCase(),
        description: c.display ?? cc.text ?? null,
      };
    }
  }
  return null;
}

function extractIcd10(cc: FhirCodeableConcept | undefined): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (
      typeof c.code === "string" &&
      typeof c.system === "string" &&
      c.system.toLowerCase().includes("icd-10")
    ) {
      return c.code.toUpperCase();
    }
  }
  return null;
}

function extractDocKind(cc: FhirCodeableConcept | undefined): string {
  const display = (cc?.text ?? cc?.coding?.[0]?.display ?? "").toLowerCase();
  if (display.includes("prescription") || display.includes("rx"))
    return "prescription";
  if (
    display.includes("face-to-face") ||
    display.includes("face to face") ||
    display.includes("f2f")
  )
    return "face_to_face";
  if (display.includes("sleep study") || display.includes("polysomnography"))
    return "sleep_study";
  if (display.includes("chart") || display.includes("progress"))
    return "chart_note";
  if (display.includes("cmn")) return "cmn";
  return "other";
}

function dedupeUpper(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const u = v.toUpperCase().replace(/\s+/g, "");
    if (u.length > 0 && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function normalisePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function normaliseNpi(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
