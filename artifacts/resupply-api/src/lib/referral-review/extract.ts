// Referral-packet extraction — the AI pass behind the Referral Reviewer.
//
// A new-patient referral arrives as a multi-document fax packet (or an
// admin-uploaded PDF): a demographics sheet, insurance info, the
// physician's order, and a sleep study. This module runs the whole
// packet through Claude's document path ONCE and returns everything the
// intake form needs — patient demographics, insurance, ordered items,
// sleep-study results, referring physician — plus a per-section
// page-range map so the accept step can split the packet into named
// per-document PDFs for the chart.
//
// Design choices (mirrors lib/inbound-fax/ocr.ts):
//   * Reuses the existing Claude client (getAnthropicClient). No new
//     vendor, no new key. Referral packets are PHI; the request is the
//     document itself.
//   * Fail-soft. No ANTHROPIC_API_KEY → { status: "offline" }; a model
//     or parse error → { status: "failed" } — never throws into the
//     caller (a worker job or the on-demand re-run route).
//   * PDF only. The triage OCR accepts single-page images, but a
//     referral is a multi-page document and the page-range map is
//     meaningless for anything else. TIFF faxes → "unsupported" and the
//     CSR triages by hand (Telnyx delivers PDF by default).
//   * PHI-safe logging. We log ONLY status, model, latency, content
//     type, and byte size — NEVER the document bytes or any extracted
//     field.

import { z } from "zod";

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
  sendWithRetry,
} from "../llm-provider";
import { logger } from "../logger";

export const REFERRAL_EXTRACT_PDF_TYPE = "application/pdf";

/** Hard cap on the bytes we'll base64 + ship to the model. Matches the
 *  fax-ingest media cap (10 MB) so anything that made it into storage
 *  is extractable. */
export const REFERRAL_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;

const trimmed = (max: number) => z.string().trim().max(max);

const addressSchema = z
  .object({
    line1: trimmed(120).nullable(),
    line2: trimmed(120).nullable(),
    city: trimmed(80).nullable(),
    state: trimmed(40).nullable(),
    postalCode: trimmed(20).nullable(),
  })
  .strict();

const insuranceSchema = z
  .object({
    payerName: trimmed(120).nullable(),
    planName: trimmed(120).nullable(),
    memberId: trimmed(80).nullable(),
    groupNumber: trimmed(80).nullable(),
    policyholderName: trimmed(160).nullable(),
    /** Free text as written ("self", "spouse", …) — the accept form maps
     *  it onto the insurance_coverages enum; the model must not guess. */
    policyholderRelationship: trimmed(40).nullable(),
  })
  .strict();

const orderItemSchema = z
  .object({
    description: trimmed(200),
    hcpcs: trimmed(16).nullable(),
  })
  .strict();

const sleepStudySchema = z
  .object({
    studyDate: trimmed(40).nullable(),
    /** As written: "in-lab PSG", "home sleep test", "split night", … */
    studyType: trimmed(80).nullable(),
    ahi: z.number().nullable(),
    rdi: z.number().nullable(),
    odi: z.number().nullable(),
    totalSleepMinutes: z.number().nullable(),
    interpretingPhysician: trimmed(200).nullable(),
  })
  .strict();

const physicianSchema = z
  .object({
    name: trimmed(200).nullable(),
    npi: trimmed(20).nullable(),
    phone: trimmed(40).nullable(),
    fax: trimmed(40).nullable(),
    clinic: trimmed(200).nullable(),
  })
  .strict();

/** Per-section page ranges (1-based, inclusive) so the accept step can
 *  split the packet into named per-document chart PDFs. */
export const referralSectionTypes = [
  "sleep_study",
  "physician_order",
  "demographics",
  "insurance_card",
  "chart_note",
  "other",
] as const;

const documentSectionSchema = z
  .object({
    type: z.enum(referralSectionTypes),
    pageStart: z.number().int().min(1),
    pageEnd: z.number().int().min(1),
    title: trimmed(120),
  })
  .strict();

const confidenceLevel = z.enum(["high", "medium", "low"]);

/** The shape we ask the model to return, and persist verbatim. Every
 *  leaf is nullable — a packet may not contain it, and we never want a
 *  hallucinated value. */
export const referralExtractionSchema = z
  .object({
    patient: z
      .object({
        firstName: trimmed(80).nullable(),
        lastName: trimmed(80).nullable(),
        dob: trimmed(40).nullable(),
        phone: trimmed(40).nullable(),
        email: trimmed(254).nullable(),
        address: addressSchema.nullable(),
      })
      .strict(),
    insurance: insuranceSchema.nullable(),
    secondaryInsurance: insuranceSchema.nullable(),
    order: z.array(orderItemSchema).max(40),
    sleepStudy: sleepStudySchema.nullable(),
    physician: physicianSchema.nullable(),
    documents: z.array(documentSectionSchema).max(20),
    summary: trimmed(600).nullable(),
    confidence: z
      .object({
        patient: confidenceLevel,
        insurance: confidenceLevel,
        order: confidenceLevel,
        sleepStudy: confidenceLevel,
      })
      .strict(),
  })
  .strict();

export type ReferralExtraction = z.infer<typeof referralExtractionSchema>;
export type ReferralSectionType = (typeof referralSectionTypes)[number];

export type ReferralExtractionResult =
  | {
      status: "extracted";
      model: string;
      extractedAt: string;
      extraction: ReferralExtraction;
    }
  | { status: "offline" }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

const SYSTEM_PROMPT =
  "You are a medical-records intake assistant for a CPAP/DME supplier. " +
  "You are shown a complete inbound referral packet — typically a " +
  "demographics/face sheet, insurance information, a physician order or " +
  "prescription, and a sleep study, faxed together as one PDF. " +
  "Transcribe ONLY what is actually written in the document into the " +
  "requested JSON. Never guess or invent a value: if a field is not " +
  "present, return null for it (or an empty array). Dates stay exactly " +
  "as written, EXCEPT the patient date of birth: when a full date of " +
  "birth is legible, normalise it to YYYY-MM-DD; otherwise null. Phone " +
  "numbers: digits and leading + only when clearly legible, else as " +
  "written. The documents array must classify every distinct section of " +
  "the packet with its 1-based inclusive page range; ranges may not " +
  "overlap and should together cover the packet. Set a section of " +
  "confidence to 'low' when the relevant pages are faint, handwritten, " +
  "or ambiguous.";

const USER_PROMPT =
  "Extract the referral intake fields from this packet. Respond with " +
  "ONLY a JSON object (no prose, no markdown fence) matching exactly " +
  "this shape:\n" +
  "{\n" +
  '  "patient": {\n' +
  '    "firstName": string | null,\n' +
  '    "lastName": string | null,\n' +
  '    "dob": string | null,            // YYYY-MM-DD when legible\n' +
  '    "phone": string | null,\n' +
  '    "email": string | null,\n' +
  '    "address": { "line1": string | null, "line2": string | null, "city": string | null, "state": string | null, "postalCode": string | null } | null\n' +
  "  },\n" +
  '  "insurance": { "payerName": string | null, "planName": string | null, "memberId": string | null, "groupNumber": string | null, "policyholderName": string | null, "policyholderRelationship": string | null } | null,\n' +
  '  "secondaryInsurance": { ...same shape as insurance... } | null,\n' +
  '  "order": [ { "description": string, "hcpcs": string | null } ],\n' +
  '  "sleepStudy": { "studyDate": string | null, "studyType": string | null, "ahi": number | null, "rdi": number | null, "odi": number | null, "totalSleepMinutes": number | null, "interpretingPhysician": string | null } | null,\n' +
  '  "physician": { "name": string | null, "npi": string | null, "phone": string | null, "fax": string | null, "clinic": string | null } | null,\n' +
  '  "documents": [ { "type": "sleep_study" | "physician_order" | "demographics" | "insurance_card" | "chart_note" | "other", "pageStart": number, "pageEnd": number, "title": string } ],\n' +
  '  "summary": string | null,\n' +
  '  "confidence": { "patient": "high"|"medium"|"low", "insurance": "high"|"medium"|"low", "order": "high"|"medium"|"low", "sleepStudy": "high"|"medium"|"low" }\n' +
  "}";

/** Strip an optional ```json … ``` fence the model may add despite the
 *  instruction, then JSON.parse. Returns null on any failure. */
function parseJsonObject(text: string): unknown {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : t;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Run referral extraction on one packet's media bytes. Pure of the DB
 * and HTTP layers — the caller fetches the bytes and persists the
 * result.
 */
export async function extractReferral(input: {
  bytes: Buffer;
  contentType: string | null;
  /** Optional: lets a test inject a stub client. Defaults to the
   *  process-wide cached Anthropic client (null when no key). */
  client?: ReturnType<typeof getAnthropicClient>;
}): Promise<ReferralExtractionResult> {
  const contentType = (input.contentType ?? "")
    .toLowerCase()
    .split(";")[0]!
    .trim();
  if (contentType !== REFERRAL_EXTRACT_PDF_TYPE) {
    return {
      status: "unsupported",
      reason: `content type ${contentType || "unknown"} is not extractable (PDF only)`,
    };
  }
  if (input.bytes.length === 0) {
    return { status: "unsupported", reason: "empty media" };
  }
  if (input.bytes.length > REFERRAL_EXTRACT_MAX_BYTES) {
    return { status: "unsupported", reason: "media exceeds extraction cap" };
  }

  // Honour an explicitly-injected client (including null, which a test
  // uses to force the offline path); otherwise use the cached client.
  const client = "client" in input ? input.client : getAnthropicClient();
  if (!client) return { status: "offline" };

  const startedAt = Date.now();
  // Retry a transient 429 / 5xx / network blip before failing the pass
  // — non-streaming, so replay is safe.
  const result = await sendWithRetry(client, {
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: input.bytes.toString("base64"),
            },
          },
          { type: "text", text: USER_PROMPT },
        ],
      },
    ],
  });

  if (!result.ok) {
    logger.warn(
      {
        event: "referral_extract_model_error",
        contentType,
        bytes: input.bytes.length,
        errorCode: result.errorCode,
        latencyMs: Date.now() - startedAt,
      },
      "referral extraction: model call failed",
    );
    return { status: "failed", reason: result.errorCode };
  }

  const parsed = parseJsonObject(getResponseText(result.response));
  const validated = referralExtractionSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn(
      {
        event: "referral_extract_parse_error",
        contentType,
        latencyMs: result.latencyMs,
        // The validation issues describe SHAPE, not patient data.
        issues: validated.error.issues.slice(0, 5).map((i) => i.path.join(".")),
      },
      "referral extraction: model output did not match the expected shape",
    );
    return { status: "failed", reason: "unparseable_model_output" };
  }

  logger.info(
    {
      event: "referral_extracted",
      contentType,
      bytes: input.bytes.length,
      model: DEFAULT_ANTHROPIC_MODEL_CHAT,
      latencyMs: result.latencyMs,
      sections: validated.data.documents.length,
      // confidence is a coarse quality signal, not PHI.
      confidence: validated.data.confidence,
    },
    "referral extraction: fields extracted",
  );
  return {
    status: "extracted",
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    extractedAt: new Date().toISOString(),
    extraction: validated.data,
  };
}
