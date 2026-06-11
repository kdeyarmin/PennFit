// HMAC-SHA256 signed tokens for fax cover-letter document URLs.
//
// When the physician-fax-outreach route dispatches via Telnyx, it
// passes a `mediaUrl` pointing to GET /fax/document/:token. Telnyx
// fetches that URL to retrieve the cover-letter PDF. The token
// carries the outreach row ID and a short TTL (1 hour), preventing
// enumeration of PHI without requiring Telnyx to send admin credentials.
//
// Uses the same RESUPPLY_LINK_HMAC_KEY as email link tokens — no new
// secrets required.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

interface FaxDocumentPayload {
  /** Document row ID (uuid). For physician outreach this is the
   *  physician_fax_outreach row; for an appeal it's the
   *  claim_appeal_letters row. For a PA request form it's the composite
   *  `${patientId}:${paId}` (the PA render is scoped to its patient). */
  id: string;
  /** Document kind. Absent on legacy tokens → physician outreach. */
  k?: FaxDocumentKind;
  /** Expiry as Unix seconds */
  e: number;
}

export type FaxDocumentKind =
  | "physician_outreach"
  | "appeal_letter"
  | "manual_document"
  | "manual_document_packet"
  | "pa_request";

const DEFAULT_TTL_SECONDS = 3600; // 1 hour — Telnyx fetches immediately

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return null;
  const pad = (4 - (s.length % 4)) % 4;
  const standard = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  try {
    return Buffer.from(standard, "base64");
  } catch {
    return null;
  }
}

function hmacSign(payloadEncoded: string): Buffer {
  return createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
}

function signToken(payload: FaxDocumentPayload): string {
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

/** Sign a physician-outreach cover-letter token (legacy default kind —
 *  payload omits `k` so existing token bytes are unchanged). */
export function signFaxDocumentToken(
  outreachId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  return signToken({
    id: outreachId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** Sign an appeal-letter fax token (kind=appeal_letter). */
export function signAppealFaxToken(
  appealLetterId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  return signToken({
    id: appealLetterId,
    k: "appeal_letter",
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** Sign a manual-document fax token (kind=manual_document). */
export function signManualDocumentFaxToken(
  manualDocumentId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  return signToken({
    id: manualDocumentId,
    k: "manual_document",
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** Sign a manual-document-packet fax token (kind=manual_document_packet). */
export function signManualDocumentPacketFaxToken(
  packetId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  return signToken({
    id: packetId,
    k: "manual_document_packet",
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** Sign a PA-request-form fax token (kind=pa_request). The id is the
 *  composite `${patientId}:${paId}` so the render stays patient-scoped. */
export function signPaRequestFaxToken(
  patientId: string,
  paId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  return signToken({
    id: `${patientId}:${paId}`,
    k: "pa_request",
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export type VerifyFaxDocumentTokenResult =
  | { valid: true; outreachId: string; kind: FaxDocumentKind }
  | { valid: false };

export function verifyFaxDocumentToken(
  token: string,
): VerifyFaxDocumentTokenResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return { valid: false };

  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false };

  const expected = hmacSign(payloadEncoded);
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
    return { valid: false };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { valid: false };
  }

  const p = parsed as FaxDocumentPayload;
  if (!p || typeof p.id !== "string" || !p.id || typeof p.e !== "number") {
    return { valid: false };
  }

  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };

  // Legacy tokens (no `k`) are physician-outreach cover letters.
  const kind: FaxDocumentKind =
    p.k === "appeal_letter"
      ? "appeal_letter"
      : p.k === "manual_document"
        ? "manual_document"
        : p.k === "manual_document_packet"
          ? "manual_document_packet"
          : p.k === "pa_request"
            ? "pa_request"
            : "physician_outreach";
  return { valid: true, outreachId: p.id, kind };
}
