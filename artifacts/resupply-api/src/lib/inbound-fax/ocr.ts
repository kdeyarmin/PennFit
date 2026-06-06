// Inbound-fax OCR / field extraction (CSR #C2).
//
// A CSR triaging an inbound fax (a prescription, sleep study, chart
// note, …) has to read the page and hand-key the patient, physician, and
// document type before they can attach it. This module runs the page
// through Claude's vision/PDF path once and returns the structured
// fields so the triage UI can pre-fill them — the CSR still confirms and
// attaches, but they're typing far less.
//
// Design choices:
//   * Reuses the existing BAA-covered Claude client (getAnthropicClient).
//     No new OCR vendor, no new key, no new BAA. Faxes contain PHI; the
//     synthesised request is patient-facing document text covered by the
//     executed Anthropic BAA.
//   * Fail-soft. No ANTHROPIC_API_KEY → { status: "offline" } and the
//     CSR keys it by hand exactly as today. A model/parse error →
//     { status: "failed" } — never throws into the request path.
//   * PHI-safe logging. We log ONLY status, model, latency, content
//     type, and byte size — NEVER the image bytes or the extracted
//     fields (which are patient-identifying).

import { z } from "zod";

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
} from "../llm-provider";
import { logger } from "../logger";

/** MIME types Claude can read directly. Anything else → "unsupported". */
export const FAX_OCR_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
] as const;
export const FAX_OCR_PDF_TYPE = "application/pdf";

/** Hard cap on the bytes we'll base64 + ship to the model (8 MB). A
 *  larger fax is unusual and would balloon the request; the CSR can
 *  still read the page in the preview pane and key it by hand. */
export const FAX_OCR_MAX_BYTES = 8 * 1024 * 1024;

const documentTypeEnum = z.enum([
  "prescription",
  "sleep_study",
  "chart_note",
  "face_to_face",
  "other",
]);

const lineItemSchema = z
  .object({
    description: z.string().max(200),
    hcpcs: z.string().max(16).nullable().optional(),
  })
  .strict();

/** The shape we ask the model to return, and persist verbatim. Every
 *  field is nullable — a fax may not contain it, and we never want a
 *  hallucinated value. */
export const faxOcrFieldsSchema = z
  .object({
    documentType: documentTypeEnum.nullable(),
    patientName: z.string().max(200).nullable(),
    patientDob: z.string().max(40).nullable(),
    patientPhone: z.string().max(40).nullable(),
    physicianName: z.string().max(200).nullable(),
    physicianNpi: z.string().max(20).nullable(),
    items: z.array(lineItemSchema).max(40),
    summary: z.string().max(400).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

export type FaxOcrFields = z.infer<typeof faxOcrFieldsSchema>;

export type FaxOcrResult =
  | { status: "extracted"; model: string; extractedAt: string; fields: FaxOcrFields }
  | { status: "offline" }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

const SYSTEM_PROMPT =
  "You are a medical-records intake assistant for a CPAP/DME supplier. " +
  "You are shown a single inbound fax (a prescription, sleep study, chart " +
  "note, face-to-face note, or other document). Transcribe ONLY what is " +
  "actually written on the page into the requested JSON. Never guess or " +
  "invent a value: if a field is not present, return null for it (or an " +
  "empty array for items). Dates stay exactly as written. Set confidence " +
  "to 'low' when the page is faint, handwritten, or ambiguous.";

const USER_PROMPT =
  "Extract the intake fields from this fax. Respond with ONLY a JSON " +
  "object (no prose, no markdown fence) matching exactly this shape:\n" +
  "{\n" +
  '  "documentType": "prescription" | "sleep_study" | "chart_note" | "face_to_face" | "other" | null,\n' +
  '  "patientName": string | null,\n' +
  '  "patientDob": string | null,\n' +
  '  "patientPhone": string | null,\n' +
  '  "physicianName": string | null,\n' +
  '  "physicianNpi": string | null,\n' +
  '  "items": [ { "description": string, "hcpcs": string | null } ],\n' +
  '  "summary": string | null,\n' +
  '  "confidence": "high" | "medium" | "low"\n' +
  "}";

/** Strip an optional ```json … ``` fence the model may add despite the
 *  instruction, then JSON.parse. Returns null on any failure. */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Run OCR/field-extraction on one fax's media bytes. Pure of the DB and
 * HTTP layers — the caller fetches the bytes and persists the result.
 */
export async function extractFaxFields(input: {
  bytes: Buffer;
  contentType: string | null;
  /** Optional: lets a test inject a stub client. Defaults to the
   *  process-wide cached Anthropic client (null when no key). */
  client?: ReturnType<typeof getAnthropicClient>;
}): Promise<FaxOcrResult> {
  const contentType = (input.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const isImage = (FAX_OCR_IMAGE_TYPES as readonly string[]).includes(contentType);
  const isPdf = contentType === FAX_OCR_PDF_TYPE;
  if (!isImage && !isPdf) {
    return {
      status: "unsupported",
      reason: `content type ${contentType || "unknown"} is not OCR-able`,
    };
  }
  if (input.bytes.length === 0) {
    return { status: "unsupported", reason: "empty media" };
  }
  if (input.bytes.length > FAX_OCR_MAX_BYTES) {
    return { status: "unsupported", reason: "media exceeds OCR size cap" };
  }

  // Honour an explicitly-injected client (including null, which a test
  // uses to force the offline path); otherwise use the cached client.
  const client = "client" in input ? input.client : getAnthropicClient();
  if (!client) return { status: "offline" };

  const data = input.bytes.toString("base64");
  // image/jpg isn't a real MIME; normalise so the API accepts it.
  const mediaType = contentType === "image/jpg" ? "image/jpeg" : contentType;
  const mediaBlock = isPdf
    ? ({
        type: "document" as const,
        source: { type: "base64" as const, media_type: "application/pdf" as const, data },
      })
    : ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: mediaType, data },
      });

  const startedAt = Date.now();
  const result = await client.send({
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: [mediaBlock, { type: "text", text: USER_PROMPT }] },
    ],
  });

  if (!result.ok) {
    logger.warn(
      {
        event: "fax_ocr_model_error",
        contentType,
        bytes: input.bytes.length,
        errorCode: result.errorCode,
        latencyMs: Date.now() - startedAt,
      },
      "fax OCR: model call failed",
    );
    return { status: "failed", reason: result.errorCode };
  }

  const parsed = parseJsonObject(getResponseText(result.response));
  const validated = faxOcrFieldsSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn(
      {
        event: "fax_ocr_parse_error",
        contentType,
        latencyMs: result.latencyMs,
        // The validation issues describe SHAPE, not patient data.
        issues: validated.error.issues.slice(0, 5).map((i) => i.path.join(".")),
      },
      "fax OCR: model output did not match the expected shape",
    );
    return { status: "failed", reason: "unparseable_model_output" };
  }

  logger.info(
    {
      event: "fax_ocr_extracted",
      contentType,
      bytes: input.bytes.length,
      model: DEFAULT_ANTHROPIC_MODEL_CHAT,
      latencyMs: result.latencyMs,
      // confidence is a coarse quality signal, not PHI.
      confidence: validated.data.confidence,
    },
    "fax OCR: fields extracted",
  );
  return {
    status: "extracted",
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    extractedAt: new Date().toISOString(),
    fields: validated.data,
  };
}
