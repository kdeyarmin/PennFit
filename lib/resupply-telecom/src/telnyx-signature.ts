// @workspace/resupply-telecom — Telnyx webhook signature validation.
//
// Telnyx signs every webhook with Ed25519 (unlike Twilio's HMAC-SHA1
// over sorted form params). The scheme:
//   1. Two headers ride the request:
//        telnyx-signature-ed25519 — base64 Ed25519 signature
//        telnyx-timestamp         — unix seconds the event was sent
//   2. The signed message is the exact string `${timestamp}|${rawBody}`
//      where rawBody is the EXACT request body bytes (no re-encoding).
//   3. Verify with the account's Ed25519 public key (base64, 32 raw
//      bytes) from Mission Control → Keys & Credentials → Public Key.
//
// Because verification is over the raw bytes, the webhook routes must be
// mounted with `express.raw({ type: "application/json" })` BEFORE the
// global `express.json()` — same posture as the Stripe webhook. The
// middleware below verifies over the raw Buffer, then parses the JSON
// and replaces `req.body` with the parsed object for the handler.
//
// PHI note: nothing here logs the body. The body carries fax numbers
// (PHI when tied to a physician office) and is never written to a log.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import type {
  SignatureResponseLike,
  SignatureNextFunction,
} from "./signature.js";

// DER SPKI prefix for an Ed25519 public key. Telnyx hands out the raw
// 32-byte key base64-encoded; Node's crypto wants a KeyObject, which we
// build by prepending this fixed 12-byte ASN.1 header to the raw key.
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKeyFromBase64(b64: string) {
  try {
    const raw = Buffer.from(b64, "base64");
    // Ed25519 public keys are exactly 32 bytes. Anything else is a
    // misconfigured key — fail closed rather than feed garbage to crypto.
    if (raw.length !== 32) return null;
    const der = Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]);
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export interface ValidateTelnyxSignatureInput {
  /** Base64 Ed25519 public key from the Telnyx portal. */
  publicKey: string;
  /** EXACT raw request body bytes (Buffer) or string. */
  payload: string | Buffer;
  /** Raw value of the `telnyx-signature-ed25519` header (base64). */
  signatureHeader: string | undefined;
  /** Raw value of the `telnyx-timestamp` header (unix seconds). */
  timestampHeader: string | undefined;
  /**
   * Optional freshness window in seconds. When > 0, the timestamp must
   * be within ±toleranceSeconds of now or validation fails. Defaults to
   * 0 (disabled): Telnyx retries a failed delivery for hours carrying
   * the ORIGINAL timestamp, and our handlers are idempotent, so a strict
   * window would reject legitimate retries for no security gain — the
   * timestamp is already covered by the signature, so it can't be forged.
   */
  toleranceSeconds?: number;
  /** Test seam for the freshness check. */
  nowSeconds?: number;
}

/**
 * Returns true iff the provided signature matches what Telnyx would
 * have sent for the given (publicKey, timestamp, payload). NEVER throws
 * on bad input — wrong → false.
 */
export function validateTelnyxSignature(
  input: ValidateTelnyxSignatureInput,
): boolean {
  if (!input.publicKey || !input.signatureHeader || !input.timestampHeader) {
    return false;
  }

  if (input.toleranceSeconds && input.toleranceSeconds > 0) {
    const ts = Number(input.timestampHeader);
    if (!Number.isFinite(ts)) return false;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > input.toleranceSeconds) return false;
  }

  const key = ed25519PublicKeyFromBase64(input.publicKey);
  if (!key) return false;

  const payloadBuf =
    typeof input.payload === "string"
      ? Buffer.from(input.payload, "utf8")
      : input.payload;
  const signedMessage = Buffer.concat([
    Buffer.from(`${input.timestampHeader}|`, "utf8"),
    payloadBuf,
  ]);

  let sig: Buffer;
  try {
    sig = Buffer.from(input.signatureHeader, "base64");
  } catch {
    return false;
  }
  // Ed25519 signatures are 64 bytes; reject anything else before crypto.
  if (sig.length !== 64) return false;

  try {
    return cryptoVerify(null, signedMessage, key, sig);
  } catch {
    return false;
  }
}

export interface TelnyxSignatureRequestLike {
  header(name: string): string | undefined;
  /** Buffer (from express.raw) on entry; replaced with parsed JSON. */
  body?: unknown;
}

export interface RequireTelnyxSignatureOptions {
  /**
   * Read the public key at request time, not at middleware-construction
   * time, so key rotation does not require a process restart and tests
   * can mutate the env between requests.
   */
  getPublicKey: () => string | undefined;
  /** Forwarded to validateTelnyxSignature. Defaults to 0 (disabled). */
  toleranceSeconds?: number;
  /**
   * Optional rejection-callback hook for tests / metrics. Defaults to a
   * 403 response.
   */
  onReject?: (
    req: TelnyxSignatureRequestLike,
    res: SignatureResponseLike,
    reason: string,
  ) => void;
}

/**
 * Express-compatible middleware. Verifies the Telnyx Ed25519 signature
 * over the RAW request body, then parses the JSON and assigns the parsed
 * object to `req.body` so downstream handlers receive normal JSON. On
 * failure responds 403 and DOES NOT call next().
 *
 * The middleware refuses to operate if the public key is unset — that
 * misconfig must fail loudly so a missing-secret deployment cannot
 * silently accept ANYTHING-as-Telnyx.
 */
export function requireTelnyxSignature(
  opts: RequireTelnyxSignatureOptions,
): (
  req: TelnyxSignatureRequestLike,
  res: SignatureResponseLike,
  next: SignatureNextFunction,
) => void {
  return (req, res, next) => {
    const publicKey = opts.getPublicKey();
    if (!publicKey) {
      reject(req, res, opts, "public_key_unset");
      return;
    }

    const raw = req.body;
    let payload: string | Buffer;
    if (Buffer.isBuffer(raw)) {
      payload = raw;
    } else if (typeof raw === "string") {
      payload = raw;
    } else {
      // No raw body to verify — the route is misconfigured (express.raw
      // must run before this middleware). Fail closed.
      reject(req, res, opts, "missing_raw_body");
      return;
    }

    if (
      !validateTelnyxSignature({
        publicKey,
        payload,
        signatureHeader: req.header("telnyx-signature-ed25519"),
        timestampHeader: req.header("telnyx-timestamp"),
        toleranceSeconds: opts.toleranceSeconds,
      })
    ) {
      reject(req, res, opts, "signature_mismatch");
      return;
    }

    // Signature is valid — hand the handler parsed JSON.
    try {
      const text = Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : payload;
      req.body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      reject(req, res, opts, "invalid_json");
      return;
    }
    next();
  };
}

function reject(
  req: TelnyxSignatureRequestLike,
  res: SignatureResponseLike,
  opts: RequireTelnyxSignatureOptions,
  reason: string,
): void {
  if (opts.onReject) {
    opts.onReject(req, res, reason);
    return;
  }
  res.status(403).type("text/plain").send("Forbidden");
}
