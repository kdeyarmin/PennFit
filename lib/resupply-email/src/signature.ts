// @workspace/resupply-email — SendGrid Event Webhook signature validation.
//
// SendGrid signs every Event Webhook POST with ECDSA over the curve
// prime256v1 (a.k.a. secp256r1 / P-256) and SHA-256. Per their docs:
//
//   1. Take `X-Twilio-Email-Event-Webhook-Timestamp` (a 10-digit
//      Unix-seconds string) from the request headers.
//   2. Take `X-Twilio-Email-Event-Webhook-Signature` (DER-encoded
//      ECDSA signature, base64) from the request headers.
//   3. Concatenate `timestamp + raw_request_body` (NOT the parsed
//      JSON — the raw bytes the request body parser saw).
//   4. ECDSA-verify the concatenation against the public key SendGrid
//      gave you in their dashboard (a base64-encoded SubjectPublicKeyInfo
//      in DER form).
//
// We re-implement instead of depending on the official @sendgrid/eventwebhook
// helper for the same reasons we re-implement Twilio's validator:
//   1. The official helper insists on a Buffer + a parsed-PEM key; we
//      want a pure function that takes (rawBody, headers, publicKeyB64)
//      so route tests can build fixtures without booting an Express app.
//   2. We want CONSTANT-TIME-by-construction. Node's crypto.verify is
//      already constant-time at the OpenSSL level for ECDSA; we don't
//      need to do any byte-compare ourselves, but we do want to make
//      the failure modes explicit (bad header → false, not throw).
//   3. We need the raw body. Express's `body-parser` gives you the
//      parsed object by default; the route handler must register
//      `express.raw({ type: "application/json" })` for the
//      sendgrid-events endpoint and pass that buffer into here.
//
// The public key env var holds the base64 SPKI value SendGrid prints in
// the "Mail Settings → Event Notification → Signed Event Webhook" page.
// We wrap it into a `crypto.KeyObject` once per request — cheap (~1ms).

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

const PUBLIC_KEY_ENV = "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";

export const SENDGRID_SIGNATURE_HEADER =
  "x-twilio-email-event-webhook-signature";
export const SENDGRID_TIMESTAMP_HEADER =
  "x-twilio-email-event-webhook-timestamp";

export interface ValidateSendgridSignatureInput {
  /** Raw request body bytes. NOT the parsed JSON. */
  rawBody: Buffer | string;
  /** Value of `X-Twilio-Email-Event-Webhook-Signature` header. */
  signatureHeader: string | undefined;
  /** Value of `X-Twilio-Email-Event-Webhook-Timestamp` header. */
  timestampHeader: string | undefined;
  /**
   * Base64-encoded SubjectPublicKeyInfo (DER) — the value SendGrid
   * shows in the dashboard. Pass the env var contents directly.
   */
  publicKeyBase64: string;
  /** Override clock for tests; defaults to system time in seconds. */
  nowSeconds?: number;
  /**
   * Allowed clock skew + replay window in seconds. Defaults to 600s
   * (matches SendGrid's published "valid for 10 minutes" guidance and
   * is in the same ballpark as Parachute's 300s and Stripe's 300s
   * defaults). A captured-but-old signed payload outside this window
   * is rejected as `stale_timestamp` so an attacker can't replay
   * indefinitely.
   */
  toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 600;

/**
 * Returns true iff the signature is a valid SendGrid Event Webhook
 * signature for `rawBody` under `publicKeyBase64`. NEVER throws on
 * malformed inputs — wrong headers, junk key, parse failure all
 * collapse to `false`. Throws only on a programming error in the call
 * itself (e.g. nullish rawBody).
 */
export function validateSendgridSignature(
  input: ValidateSendgridSignatureInput,
): boolean {
  if (input.rawBody == null) {
    throw new Error(
      "validateSendgridSignature: rawBody is required (pass the unparsed Buffer).",
    );
  }
  if (!input.signatureHeader || !input.timestampHeader) return false;
  if (!input.publicKeyBase64) return false;

  // Freshness / replay window check. The SendGrid header is a
  // 10-digit unix-seconds string. Reject obviously malformed values
  // AND values outside the tolerance window so a captured payload
  // can't be replayed days later.
  const timestampSeconds = Number.parseInt(input.timestampHeader, 10);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return false;
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Asymmetric: tolerate `tolerance` seconds of past staleness AND a
  // small future skew (clocks slightly ahead). Mirrors the Parachute
  // verifier's posture.
  if (
    timestampSeconds < nowSeconds - tolerance ||
    timestampSeconds > nowSeconds + tolerance
  ) {
    return false;
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(input.publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return false;
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(input.signatureHeader, "base64");
    if (signature.length === 0) return false;
  } catch {
    return false;
  }

  const bodyBuf =
    typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody, "utf8")
      : input.rawBody;
  const tsBuf = Buffer.from(input.timestampHeader, "utf8");
  const message = Buffer.concat([tsBuf, bodyBuf]);

  try {
    const verifier = createVerify("sha256");
    verifier.update(message);
    verifier.end();
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

// Express middleware shape. Same duck-typed approach as Twilio's so
// resupply-email does not take a hard dependency on express.

export interface SendgridSigRequestLike {
  header(name: string): string | undefined;
  body?: unknown;
  /**
   * Express's `express.raw()` body parser leaves the original buffer
   * on req.body. We accept either:
   *   - a Buffer on `body` (express.raw mode), OR
   *   - a string on `rawBody` (custom verifier middleware).
   * The middleware below tries Buffer first, then rawBody fallback.
   */
  rawBody?: string;
}

export interface SendgridSigResponseLike {
  status(code: number): SendgridSigResponseLike;
  type(mime: string): SendgridSigResponseLike;
  send(body: string): SendgridSigResponseLike;
}

export type SendgridSigNext = (err?: unknown) => void;

export interface RequireSendgridSignatureOptions {
  /**
   * Override the env-var read. Tests pass the public key directly so
   * they don't have to mutate process.env. Production leaves undefined
   * and reads SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY at request time.
   */
  publicKeyBase64?: string;
}

/**
 * Express middleware that drops requests that did not come from
 * SendGrid. Call AFTER `express.raw({ type: "application/json" })`
 * for this endpoint — without the raw buffer the signature check
 * cannot reproduce the bytes SendGrid signed.
 *
 * 401 on missing/bad signature; 503 on missing public-key env so
 * admins see the misconfig immediately instead of every event
 * silently 401ing.
 */
export function requireSendgridSignature(
  opts: RequireSendgridSignatureOptions = {},
) {
  return function sendgridSignatureMiddleware(
    req: SendgridSigRequestLike,
    res: SendgridSigResponseLike,
    next: SendgridSigNext,
  ): void {
    const publicKeyBase64 = opts.publicKeyBase64 ?? process.env[PUBLIC_KEY_ENV];
    if (!publicKeyBase64) {
      res
        .status(503)
        .type("text/plain")
        .send("SendGrid signature key not configured");
      return;
    }

    const signatureHeader = req.header(SENDGRID_SIGNATURE_HEADER);
    const timestampHeader = req.header(SENDGRID_TIMESTAMP_HEADER);

    let rawBody: Buffer | string | undefined;
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body;
    } else if (typeof req.rawBody === "string") {
      rawBody = req.rawBody;
    } else if (typeof req.body === "string") {
      rawBody = req.body;
    }

    if (!rawBody) {
      res
        .status(400)
        .type("text/plain")
        .send("SendGrid webhook requires raw body — register express.raw()");
      return;
    }

    const ok = validateSendgridSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      publicKeyBase64,
    });
    if (!ok) {
      res.status(401).type("text/plain").send("Invalid SendGrid signature");
      return;
    }
    next();
  };
}
