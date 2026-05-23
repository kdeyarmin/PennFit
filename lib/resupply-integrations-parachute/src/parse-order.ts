// Parachute Health webhook payload → typed ParachuteOrder.
//
// Strict on shape (the dispatcher must know what it has), lenient
// on optionality (real partner payloads always have surprise null
// fields). Anything we can't make sense of becomes a tagged failure
// so the dispatcher can keep the inbound_webhooks row in
// processing_failed for human triage rather than silently dropping
// data.

import { z } from "zod";

import type {
  ParachuteDocument,
  ParachuteHcpcsLine,
  ParachuteOrder,
} from "./types";

const stringOrNull = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === "string" && v.length > 0 ? v : null));

const numberOrNull = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  });

const hcpcsLineSchema = z.object({
  code: z.string().trim().min(1).max(10),
  modifiers: z.array(z.string().trim().max(4)).optional().default([]),
  quantity: z.union([z.number(), z.string()]).optional().default(1),
  description: stringOrNull.optional(),
});

// Strict URL protocol validator for partner-supplied document links.
// A Parachute payload that ships a `javascript:fetch(...+document.cookie)`
// in `url` would otherwise persist into inbound_referral_documents
// and render as <a href={d.sourceUrl}> on /admin/inbound-referrals —
// an admin clicking the link executes JS in the admin-session origin
// (rel="noopener noreferrer" does NOT block javascript: URLs).
// Allow only http: / https:; anything else (data:, file:, vbscript:,
// javascript:, custom protocols) collapses to null.
const httpUrlOrNull = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (typeof v !== "string" || v.length === 0) return null;
    try {
      const parsed = new URL(v);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return v;
      }
      return null;
    } catch {
      return null;
    }
  });

const documentSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(40).optional().default("other"),
  filename: stringOrNull.optional(),
  content_type: stringOrNull.optional(),
  size_bytes: numberOrNull.optional(),
  url: httpUrlOrNull.optional(),
});

const patientSchema = z.object({
  id: stringOrNull.optional(),
  first_name: stringOrNull.optional(),
  last_name: stringOrNull.optional(),
  // YYYY-MM-DD shape — we accept anything string-shaped and normalise
  // downstream.
  dob: stringOrNull.optional(),
  phone: stringOrNull.optional(),
  email: stringOrNull.optional(),
  address_line_1: stringOrNull.optional(),
  address_line_2: stringOrNull.optional(),
  city: stringOrNull.optional(),
  state: stringOrNull.optional(),
  postal_code: stringOrNull.optional(),
});

const providerSchema = z.object({
  npi: stringOrNull.optional(),
  first_name: stringOrNull.optional(),
  last_name: stringOrNull.optional(),
  facility_name: stringOrNull.optional(),
});

const payloadSchema = z.object({
  order_id: z.string().trim().min(1).max(120),
  event_type: z.string().trim().min(1).max(60).optional().default("order.created"),
  occurred_at: z.string().trim().min(1).optional(),
  patient: patientSchema.optional().default({}),
  provider: providerSchema.optional().default({}),
  payer_name: stringOrNull.optional(),
  member_id: stringOrNull.optional(),
  items: z.array(hcpcsLineSchema).optional().default([]),
  diagnoses: z.array(z.string().trim()).optional().default([]),
  documents: z.array(documentSchema).optional().default([]),
  clinical_note: stringOrNull.optional(),
});

export type ParseOutcome =
  | { ok: true; order: ParachuteOrder }
  | { ok: false; reason: "invalid_shape"; issues: ParseIssue[] };

export interface ParseIssue {
  path: string;
  message: string;
}

/**
 * Parse and validate an unknown Parachute Health webhook payload into a typed ParachuteOrder structure.
 *
 * @param input - The raw webhook payload to validate and convert
 * @returns `{ ok: true; order: ParachuteOrder }` when the payload is valid; otherwise `{ ok: false; reason: "invalid_shape"; issues: ParseIssue[] }` with a list of validation issues describing invalid or missing fields
 */
export function parseParachuteOrder(input: unknown): ParseOutcome {
  const result = payloadSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      reason: "invalid_shape",
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const p = result.data;
  const order: ParachuteOrder = {
    sourceOrderId: p.order_id,
    eventType: p.event_type,
    occurredAt: p.occurred_at ?? new Date().toISOString(),
    patient: {
      sourcePatientId: p.patient.id ?? null,
      firstName: p.patient.first_name ?? null,
      lastName: p.patient.last_name ?? null,
      dob: p.patient.dob ?? null,
      phoneE164: normalisePhone(p.patient.phone),
      email: p.patient.email ?? null,
      addressLine1: p.patient.address_line_1 ?? null,
      addressLine2: p.patient.address_line_2 ?? null,
      city: p.patient.city ?? null,
      state: p.patient.state ?? null,
      postalCode: p.patient.postal_code ?? null,
    },
    provider: {
      npi: normaliseNpi(p.provider.npi),
      firstName: p.provider.first_name ?? null,
      lastName: p.provider.last_name ?? null,
      facilityName: p.provider.facility_name ?? null,
    },
    payerName: p.payer_name ?? null,
    memberId: p.member_id ?? null,
    hcpcsLines: p.items.map(normaliseHcpcsLine),
    icd10Codes: p.diagnoses.map((d) => d.toUpperCase().replace(/\s+/g, "")).filter((d) => d.length > 0),
    documents: p.documents.map(normaliseDocument),
    clinicalNote: p.clinical_note ?? null,
  };
  return { ok: true, order };
}

/**
 * Normalize a validated HCPCS line into the canonical ParachuteHcpcsLine shape.
 *
 * @param line - The HCPCS line as validated by `hcpcsLineSchema`
 * @returns A `ParachuteHcpcsLine` where:
 *  - `code` is uppercased and trimmed,
 *  - `modifiers` are uppercased, trimmed, empty entries removed, and limited to 4 entries,
 *  - `quantity` is a positive number (defaults to `1` when missing, non-finite, or <= 0),
 *  - `description` is the provided string or `null`
 */
function normaliseHcpcsLine(
  line: z.infer<typeof hcpcsLineSchema>,
): ParachuteHcpcsLine {
  const q =
    typeof line.quantity === "number"
      ? line.quantity
      : Number(line.quantity);
  return {
    code: line.code.toUpperCase().trim(),
    modifiers: (line.modifiers ?? [])
      .map((m) => m.toUpperCase().trim())
      .filter((m) => m.length > 0)
      .slice(0, 4),
    quantity: Number.isFinite(q) && q > 0 ? q : 1,
    description: line.description ?? null,
  };
}

/**
 * Map a validated document payload to a ParachuteDocument, normalizing optional fields to `null`.
 *
 * @param doc - The parsed `documentSchema` object to convert
 * @returns A `ParachuteDocument` whose fields are mapped from `doc`, with missing optional values set to `null`
 */
function normaliseDocument(
  doc: z.infer<typeof documentSchema>,
): ParachuteDocument {
  return {
    sourceDocumentId: doc.id,
    kind: doc.kind,
    filename: doc.filename ?? null,
    contentType: doc.content_type ?? null,
    sizeBytes: doc.size_bytes ?? null,
    sourceUrl: doc.url ?? null,
  };
}

/**
 * Normalizes a Parachute-provided phone value to E.164 when possible.
 *
 * @param raw - The raw phone value from the payload; may be `string`, `null`, or `undefined`
 * @returns An E.164 phone string (starting with `+`) when successfully normalized, the original `raw` string when it cannot be normalized, or `null` when `raw` is empty or not a string
 */
function normalisePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

/**
 * Convert an NPI-like input into a normalized 10-digit NPI string.
 *
 * @param raw - Input that may contain an NPI with formatting characters, or `null`/`undefined`
 * @returns The 10-digit NPI (digits only) if `raw` contains exactly 10 digits after stripping nondigits, `null` otherwise
 */
function normaliseNpi(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}
