// AI extraction of ADR fields from an inbound audit/ADR fax letter.
//
// Reuses the existing Claude document path (same as referral review / fax OCR)
// to read a payer or contractor's Additional Documentation Request letter and
// pull the few fields that pre-fill the "Log ADR" form — the contractor/source,
// the claim number, the response deadline, the payer, and any ADR reference.
// Fail-soft: offline when no ANTHROPIC_API_KEY, never throws.

import { z } from "zod";

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
  sendWithRetry,
} from "../llm-provider";
import { logger } from "../logger";

const MAX_BYTES = 8 * 1024 * 1024;

export const adrExtractionSchema = z
  .object({
    source: z
      .enum(["rac", "cert", "tpe", "upic", "payer_medical_review", "other"])
      .nullable()
      .optional(),
    contractorName: z.string().max(200).nullable().optional(),
    payerName: z.string().max(200).nullable().optional(),
    claimNumber: z.string().max(120).nullable().optional(),
    adrReference: z.string().max(200).nullable().optional(),
    responseDue: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
  })
  .strip();

export type AdrExtraction = z.infer<typeof adrExtractionSchema>;

export type AdrExtractionResult =
  | { status: "extracted"; fields: AdrExtraction }
  | { status: "offline" }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

const SYSTEM_PROMPT =
  "You read Medicare and commercial-payer audit letters — Additional " +
  "Documentation Requests (ADRs) from RAC, CERT, TPE, UPIC, or a payer's " +
  "medical-review unit. Extract only the requested fields. Return STRICT JSON " +
  "with no prose. Use null for anything not clearly stated. Dates must be " +
  "YYYY-MM-DD. Never guess a deadline that is not on the letter.";

const USER_PROMPT = `Extract these fields as JSON:
{
  "source": one of "rac" | "cert" | "tpe" | "upic" | "payer_medical_review" | "other" | null,
  "contractorName": string | null,   // the auditing contractor / reviewer name
  "payerName": string | null,
  "claimNumber": string | null,      // the claim / ICN / DCN under review
  "adrReference": string | null,     // the ADR / case / letter reference number
  "responseDue": "YYYY-MM-DD" | null, // the documentation response due date
  "confidence": "high" | "medium" | "low"
}`;

/** Tolerant JSON-object extraction from model text. */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function extractAdrFromFax(input: {
  bytes: Buffer;
  contentType: string | null;
}): Promise<AdrExtractionResult> {
  const client = getAnthropicClient();
  if (!client) return { status: "offline" };
  if (!input.contentType || !input.contentType.toLowerCase().includes("pdf")) {
    return { status: "unsupported", reason: "content_type" };
  }
  if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) {
    return { status: "unsupported", reason: "size" };
  }

  const result = await sendWithRetry(client, {
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 512,
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
      { event: "adr_extract_model_error", errorCode: result.errorCode },
      "adr extraction: model call failed",
    );
    return { status: "failed", reason: result.errorCode };
  }
  const parsed = parseJsonObject(getResponseText(result.response));
  const validated = adrExtractionSchema.safeParse(parsed);
  if (!validated.success) return { status: "failed", reason: "shape_error" };
  return { status: "extracted", fields: validated.data };
}
