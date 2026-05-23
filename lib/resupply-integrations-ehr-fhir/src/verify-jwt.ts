// SMART-on-FHIR Backend Services JWT verification.
//
// This is the auth gate for EHR partners (Athena, Epic, PointClickCare)
// that POST FHIR ServiceRequest bundles to /fhir/r4/ServiceRequest.
// The partner signs a JWT with their private key; we fetch their
// JWKS over HTTPS and verify the JWT signature.
//
// Spec reference: https://hl7.org/fhir/smart-app-launch/backend-services.html
//
// What we verify
// --------------
// 1. JWT header: alg = RS256 | RS384 | RS512 (asymmetric only — never HS*).
// 2. JWS signature against the JWK identified by `kid` in the JWKS.
// 3. Claims: iss, sub, aud match the tenant's expected_* fields.
//    exp is in the future. nbf (if present) is in the past.
//    iat is within a reasonable past window (no time-traveling tokens).
//    jti present (for the caller's replay store).
//
// Why hand-rolled (no `jose`)
// ---------------------------
// SMART-on-FHIR backend services is a small surface: one JWS header
// shape, one canonical algorithm family (RS256/384/512), one JWKS
// shape. Implementing it with node:crypto avoids pulling a 200KB
// dependency into the workspace lockfile.

import { createPublicKey, createVerify } from "node:crypto";

const DEFAULT_IAT_WINDOW_SECONDS = 5 * 60; // 5 minutes back-clock tolerance
const DEFAULT_LEEWAY_SECONDS = 60;
const ALLOWED_ALGS = new Set(["RS256", "RS384", "RS512"]);

export type VerifyJwtOutcome =
  | {
      ok: true;
      claims: VerifiedClaims;
    }
  | {
      ok: false;
      reason: VerifyFailureReason;
    };

export type VerifyFailureReason =
  | "malformed_token"
  | "unsupported_algorithm"
  | "missing_kid"
  | "key_not_in_jwks"
  | "signature_invalid"
  | "issuer_mismatch"
  | "subject_mismatch"
  | "audience_mismatch"
  | "token_expired"
  | "token_not_yet_valid"
  | "iat_outside_window"
  | "missing_jti";

export interface VerifiedClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  /** All other claims the token carried (passthrough). */
  raw: Record<string, unknown>;
}

export interface VerifyJwtInput {
  token: string;
  jwks: Jwks;
  expectedIssuer: string;
  expectedSubject: string;
  expectedAudience: string;
  /** Override for tests; defaults to Date.now()/1000. */
  nowSeconds?: number;
  leewaySeconds?: number;
  iatWindowSeconds?: number;
}

export interface Jwks {
  keys: Array<{
    kty: string;
    kid?: string;
    use?: string;
    alg?: string;
    n?: string;
    e?: string;
    [k: string]: unknown;
  }>;
}

/**
 * Verify a SMART-on-FHIR backend-services JWT against a JWKS.
 *
 * The caller is responsible for fetching + caching the JWKS (see
 * fetchJwks below) and for replay-store enforcement using the
 * returned `jti` claim.
 */
export function verifySmartJwt(input: VerifyJwtInput): VerifyJwtOutcome {
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed_token" };
  }
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_token" };
  }

  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!ALLOWED_ALGS.has(alg)) {
    return { ok: false, reason: "unsupported_algorithm" };
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) {
    return { ok: false, reason: "missing_kid" };
  }

  const jwk = input.jwks.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) {
    return { ok: false, reason: "key_not_in_jwks" };
  }

  // Verify signature.
  let signatureOk: boolean;
  try {
    const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    const verifier = createVerify(jwsAlgToNode(alg));
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    signatureOk = verifier.verify(publicKey, base64UrlDecode(signatureB64));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { ok: false, reason: "signature_invalid" };
  }

  // Claims.
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (iss !== input.expectedIssuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (sub !== input.expectedSubject) {
    return { ok: false, reason: "subject_mismatch" };
  }
  const aud = payload.aud;
  const audMatch =
    aud === input.expectedAudience ||
    (Array.isArray(aud) && aud.includes(input.expectedAudience));
  if (!audMatch) {
    return { ok: false, reason: "audience_mismatch" };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const leeway = input.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS;
  const iatWindow = input.iatWindowSeconds ?? DEFAULT_IAT_WINDOW_SECONDS;

  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (!exp || now > exp + leeway) {
    return { ok: false, reason: "token_expired" };
  }
  if (typeof payload.nbf === "number" && now + leeway < payload.nbf) {
    return { ok: false, reason: "token_not_yet_valid" };
  }
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  if (!iat || now - iat > iatWindow + leeway || iat - now > leeway) {
    return { ok: false, reason: "iat_outside_window" };
  }
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!jti) {
    return { ok: false, reason: "missing_jti" };
  }

  return {
    ok: true,
    claims: { iss, sub, aud: input.expectedAudience, exp, iat, jti, raw: payload },
  };
}

/** Hard cap on the JWKS response body. A real JWKS for an EHR is
 *  typically 1-5 KB (one or two RS256 keys); 256 KB is a comfortable
 *  ceiling that still defends against an upstream returning gigabytes
 *  to OOM the API. Defense-in-depth alongside the caller's SSRF
 *  wrapper. */
const MAX_JWKS_BODY_BYTES = 256 * 1024;

/**
 * Fetch a JWKS document from a partner's URL. Returns the parsed
 * Jwks shape; throws on network / shape errors so the caller can
 * surface a clear partner-onboarding error.
 *
 * Times out at 5 seconds — JWKS endpoints are CDN-fronted and fast;
 * a slow upstream is more likely a misconfigured tenant than a real
 * latency problem.
 *
 * SSRF: this function enforces only the `https://` scheme check.
 * The caller is responsible for passing a `fetchImpl` that performs
 * DNS-resolved host validation (see artifacts/resupply-api/src/lib/
 * safe-outbound.ts) so a tenant's `jwks_uri` cannot be repointed at
 * internal services via DNS rebinding. We also cap the response
 * body so a malicious upstream returning multi-GB cannot exhaust
 * memory inside the API process.
 */
export async function fetchJwks(
  jwksUri: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Jwks> {
  if (!/^https:\/\//.test(jwksUri)) {
    throw new Error("jwks_uri must be https://");
  }
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(jwksUri, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`jwks fetch failed (HTTP ${res.status})`);
  }
  // Stream-read with a hard byte cap so a hostile upstream can't OOM
  // us via a multi-GB body. `res.json()` would buffer the whole thing
  // first — we re-implement the parse on a bounded buffer instead.
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("jwks response had no body stream");
  }
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_JWKS_BODY_BYTES) {
          throw new Error(
            `jwks response exceeded size cap (${MAX_JWKS_BODY_BYTES} bytes)`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }
  const buf = Buffer.concat(chunks);
  const text = buf.toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `jwks response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { keys?: unknown }).keys)
  ) {
    throw new Error("jwks response missing `keys` array");
  }
  return body as Jwks;
}

function base64UrlDecode(input: string): Buffer {
  // Buffer.from supports base64url since Node 16.
  return Buffer.from(input, "base64url");
}

function jwsAlgToNode(alg: string): string {
  if (alg === "RS256") return "RSA-SHA256";
  if (alg === "RS384") return "RSA-SHA384";
  if (alg === "RS512") return "RSA-SHA512";
  // Caller already gated to RS256/384/512.
  throw new Error(`unsupported alg ${alg}`);
}
