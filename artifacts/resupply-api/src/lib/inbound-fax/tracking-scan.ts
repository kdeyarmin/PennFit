// Inbound-fax barcode scan — read the PennFit signature-tracking code off
// a returned fax so it can be auto-filed.
//
// Every document we send out for a provider signature is stamped with a
// short tracking code (PFS-XXXXXXXX) printed BOTH as a Code 128 barcode
// and as human-readable text (see lib/barcode/tracking-stamp.ts). When the
// signed copy is faxed back, this module reads that code off the page so
// lib/fax/auto-file-signed.ts can match it to the outstanding signature.
//
// Why vision (not a 1D barcode decoder):
//   * Received faxes are low-resolution raster (≈200 dpi), where decoding
//     a Code 128 barcode is unreliable — which is exactly why the stamp
//     ALSO prints the code as plain text right beside the bars.
//   * The Claude vision/PDF path is already wired in (BAA-covered) for the
//     on-demand fax OCR; reusing it adds no new dependency or vendor.
//   * This pass asks the model for ONLY the opaque tracking code — never
//     patient text — so it is leaner and more privacy-preserving than the
//     full OCR extraction.
//
// Design choices (mirrors lib/inbound-fax/ocr.ts):
//   * Reuses the cached Claude client. No ANTHROPIC_API_KEY → { status:
//     "offline" } and the fax falls through to manual triage.
//   * Uses the cheaper classify (Haiku) model — finding a short printed
//     code is a simple, focused read and this runs on EVERY inbound fax
//     when the flag is on.
//   * Fail-soft. A model / parse error → { status: "failed" }; it never
//     throws into the ingest path.
//   * PHI-safe logging. Logs ONLY status, model, latency, content type,
//     and byte size — never the image bytes and never the extracted code
//     (the code itself is an opaque handle, but we keep logs uniform with
//     the OCR module and avoid logging any page-derived string).

import {
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  getAnthropicClient,
  getResponseText,
  sendWithRetry,
} from "../llm-provider";
import { logger } from "../logger";
import {
  isWellFormedTrackingCode,
  normalizeTrackingCode,
} from "../signature-tracking/service";

/** MIME types Claude can read directly. Anything else → "unsupported".
 *  Inbound faxes are PDF (Telnyx default) or TIFF; TIFF is NOT in
 *  Claude's image set, so a TIFF fax scans as unsupported and the CSR
 *  triages it by hand (the vast majority of Telnyx faxes are PDF). */
export const TRACKING_SCAN_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
] as const;
export const TRACKING_SCAN_PDF_TYPE = "application/pdf";

/** Hard cap on the bytes we base64 + ship to the model (8 MB), matching
 *  the OCR cap. A larger fax is unusual; it falls through to hand triage. */
export const TRACKING_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** The model's reply when the page carries no PennFit code. */
const NONE_SENTINEL = "NONE";

export type TrackingScanResult =
  | { status: "found"; code: string }
  | { status: "not_found" }
  | { status: "offline" }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

const SYSTEM_PROMPT =
  "You are reading a single inbound fax to find one specific tracking " +
  "code. PennFit prints a signature-tracking stamp in the top-right " +
  "corner of every document it sends out for signature: a small barcode " +
  'with the caption "SIGNATURE TRACKING" and, directly below the bars, a ' +
  'human-readable code of the form "PFS-" followed by exactly 8 ' +
  "uppercase letters or digits (for example PFS-7F3K2Q9X). Report ONLY " +
  "that code. Do not transcribe anything else on the page. If the page " +
  "has no such PFS- code, the code is unreadable, or you are unsure, " +
  'reply with exactly "NONE". Never guess or invent characters.';

const USER_PROMPT =
  "What is the PennFit signature-tracking code (PFS-XXXXXXXX) on this " +
  'fax? Reply with ONLY the code, or exactly "NONE" if there isn\'t one.';

/** Pull the first PFS-style token out of the model's reply. The model is
 *  asked to return only the code, but it occasionally wraps it in a
 *  sentence; this grabs the token regardless. Returns the raw token (not
 *  yet normalised/validated) or null. */
function extractCodeToken(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.toUpperCase() === NONE_SENTINEL) return null;
  // PFS, optional separator/space, then the body — tolerant of how the
  // model renders it; normalizeTrackingCode tightens it afterwards.
  const m = trimmed.match(/PFS[\s-]*[A-Za-z0-9]{6,12}/);
  return m ? m[0] : null;
}

/**
 * Scan one fax's media bytes for the PennFit tracking code. Pure of the
 * DB and HTTP layers — the caller fetches the bytes and acts on the
 * result. Never throws.
 */
export async function scanFaxForTrackingCode(input: {
  bytes: Buffer;
  contentType: string | null;
  /** Lets a test inject a stub client (including `null` to force the
   *  offline path). Defaults to the process-wide cached client. */
  client?: ReturnType<typeof getAnthropicClient>;
}): Promise<TrackingScanResult> {
  const contentType = (input.contentType ?? "")
    .toLowerCase()
    .split(";")[0]!
    .trim();
  const isImage = (TRACKING_SCAN_IMAGE_TYPES as readonly string[]).includes(
    contentType,
  );
  const isPdf = contentType === TRACKING_SCAN_PDF_TYPE;
  if (!isImage && !isPdf) {
    return {
      status: "unsupported",
      reason: `content type ${contentType || "unknown"} is not scannable`,
    };
  }
  if (input.bytes.length === 0) {
    return { status: "unsupported", reason: "empty media" };
  }
  if (input.bytes.length > TRACKING_SCAN_MAX_BYTES) {
    return { status: "unsupported", reason: "media exceeds scan size cap" };
  }

  const client = "client" in input ? input.client : getAnthropicClient();
  if (!client) return { status: "offline" };

  const data = input.bytes.toString("base64");
  // image/jpg isn't a real MIME; normalise so the API accepts it.
  const mediaType = contentType === "image/jpg" ? "image/jpeg" : contentType;
  const mediaBlock = isPdf
    ? {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data,
        },
      }
    : {
        type: "image" as const,
        source: { type: "base64" as const, media_type: mediaType, data },
      };

  const startedAt = Date.now();
  const result = await sendWithRetry(client, {
    model: DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
    // The reply is a single short code or "NONE" — keep it tight.
    max_tokens: 32,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [mediaBlock, { type: "text", text: USER_PROMPT }],
      },
    ],
  });

  if (!result.ok) {
    logger.warn(
      {
        event: "fax_tracking_scan_model_error",
        contentType,
        bytes: input.bytes.length,
        errorCode: result.errorCode,
        latencyMs: Date.now() - startedAt,
      },
      "fax tracking scan: model call failed",
    );
    return { status: "failed", reason: result.errorCode };
  }

  const token = extractCodeToken(getResponseText(result.response));
  // A read that isn't one of our codes is treated as "no code on the
  // page" rather than a match attempt — we never look up a value that
  // can't be ours.
  const matched = token && isWellFormedTrackingCode(token);

  logger.info(
    {
      event: "fax_tracking_scan",
      contentType,
      bytes: input.bytes.length,
      model: DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
      latencyMs: result.latencyMs,
      // Whether a well-formed code was found — NOT the code itself.
      found: Boolean(matched),
    },
    "fax tracking scan: complete",
  );

  if (!matched) return { status: "not_found" };
  return { status: "found", code: normalizeTrackingCode(token) };
}
