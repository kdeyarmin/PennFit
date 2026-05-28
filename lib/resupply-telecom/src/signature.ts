// @workspace/resupply-telecom — Twilio request-signature validation.
//
// Why we re-implement instead of using `twilio.validateRequest`:
//   1. The official validator wants the raw `Request` object and is
//      coupled to express's body-parser quirks. We want a pure function
//      that takes (url, params, header, authToken) so route tests can
//      construct fixtures without booting an Express app.
//   2. We want a CONSTANT-TIME compare. The official helper does
//      `expected === provided`, which is variable-time and leaks the
//      first divergent byte under a sufficiently determined attacker
//      with timing access. Belt-and-braces; the practical attack
//      surface is small but the fix is one line of `crypto.timingSafeEqual`.
//
// The algorithm (per Twilio "Validating Signatures from Twilio"):
//   1. Take the full URL Twilio POSTed to (scheme + host + path +
//      original query string).
//   2. Sort the application/x-www-form-urlencoded body params by key
//      (lexicographic, ASCII).
//   3. Concatenate URL + key1 + value1 + key2 + value2 + ... (no
//      separators, no encoding).
//   4. HMAC-SHA1 with the auth token as the key.
//   5. Base64-encode the digest.
//   6. Compare to the value of the `X-Twilio-Signature` header.
//
// IMPORTANT URL-PROXY HAZARD:
//   When Twilio POSTs to a domain that's behind a reverse proxy (which
//   is exactly our setup on Railway), the URL Twilio signed is the
//   PUBLIC one — `https://<railway-public-domain>/resupply-api/voice/...`
//   — NOT the internal `http://localhost:<PORT>/...` Express sees. The
//   caller is responsible for reconstructing the public URL before
//   calling validateTwilioSignature. The route handler builds it from
//   `RESUPPLY_VOICE_PUBLIC_BASE_URL` (or the RAILWAY_PUBLIC_DOMAIN
//   fallback) plus `req.originalUrl`.

import { createHmac, timingSafeEqual } from "node:crypto";

// Structural typing for express so resupply-telecom does NOT take a
// hard dependency on express. The route handler in the API has the
// real express types and will satisfy these shapes by duck-typing.
// (We considered making express a peer dep, but the only thing this
// file needs from express is the (req, res, next) signature shape.)

export interface SignatureRequestLike {
  header(name: string): string | undefined;
  body?: unknown;
}

export interface SignatureResponseLike {
  status(code: number): SignatureResponseLike;
  type(mime: string): SignatureResponseLike;
  send(body: string): SignatureResponseLike;
}

export type SignatureNextFunction = (err?: unknown) => void;

export interface ValidateSignatureInput {
  authToken: string;
  /** Public, fully-qualified URL the request was POSTed to. See the file header. */
  url: string;
  /** Form-encoded body params. Empty object for GETs. */
  params: Record<string, string>;
  /** Raw value of the `X-Twilio-Signature` header. */
  signatureHeader: string | undefined;
}

/**
 * Returns true iff the provided signature matches what Twilio would
 * have sent for the given (url, params, authToken). Constant-time
 * compare. NEVER throws on bad input — wrong → false.
 */
export function validateTwilioSignature(
  input: ValidateSignatureInput,
): boolean {
  if (!input.authToken || !input.signatureHeader) return false;

  // Build the canonical string Twilio expects: URL + sorted(k+v) join.
  const sortedKeys = Object.keys(input.params).sort();
  let canonical = input.url;
  for (const k of sortedKeys) {
    canonical += k + (input.params[k] ?? "");
  }

  const expected = createHmac("sha1", input.authToken)
    .update(canonical, "utf8")
    .digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(input.signatureHeader, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface RequireTwilioSignatureOptions {
  /**
   * Read the auth token at request time, not at middleware-construction
   * time, so secrets rotation does not require a process restart and
   * tests can mutate the env between requests.
   */
  getAuthToken: () => string | undefined;
  /**
   * Build the URL Twilio originally signed. Caller owns this so the
   * middleware doesn't have to know how the public origin is
   * configured.
   */
  buildPublicUrl: (req: SignatureRequestLike) => string;
  /**
   * Optional rejection-callback hook for tests / metrics. Defaults to
   * a 403 response — matches how Twilio's own examples reject
   * unsigned requests.
   */
  onReject?: (
    req: SignatureRequestLike,
    res: SignatureResponseLike,
    reason: string,
  ) => void;
}

/**
 * Express-compatible middleware. If validation fails, responds 403 and
 * DOES NOT call next(). On success, calls next().
 *
 * The middleware refuses to operate if the auth token is unset — that
 * misconfig has to fail loudly so a missing-secret deployment cannot
 * silently accept ANYTHING-as-Twilio.
 */
export function requireTwilioSignature(
  opts: RequireTwilioSignatureOptions,
): (
  req: SignatureRequestLike,
  res: SignatureResponseLike,
  next: SignatureNextFunction,
) => void {
  return (req, res, next) => {
    const token = opts.getAuthToken();
    if (!token) {
      reject(req, res, opts, "auth_token_unset");
      return;
    }
    const sig = req.header("x-twilio-signature");
    const url = opts.buildPublicUrl(req);
    // express.urlencoded gives us a parsed object — coerce values to
    // string (the only legal shape Twilio sends; arrays would only
    // appear from a malicious client trying to confuse the canonical
    // string).
    const params: Record<string, string> = {};
    if (req.body && typeof req.body === "object") {
      for (const [k, v] of Object.entries(
        req.body as Record<string, unknown>,
      )) {
        if (typeof v === "string") params[k] = v;
      }
    }
    if (
      validateTwilioSignature({
        authToken: token,
        url,
        params,
        signatureHeader: sig,
      })
    ) {
      next();
      return;
    }
    reject(req, res, opts, "signature_mismatch");
  };
}

function reject(
  req: SignatureRequestLike,
  res: SignatureResponseLike,
  opts: RequireTwilioSignatureOptions,
  reason: string,
): void {
  if (opts.onReject) {
    opts.onReject(req, res, reason);
    return;
  }
  res.status(403).type("text/plain").send("Forbidden");
}
