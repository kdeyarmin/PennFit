import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";

import { verifySmartJwt, type Jwks } from "./verify-jwt";

// Generate one RSA keypair and reuse it across the suite — keygen
// is the slowest part of these tests.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const KID = "test-kid-1";
const ISS = "https://athena.example.com";
const SUB = "https://athena.example.com";
const AUD = "https://pennfit.test/fhir/r4/ServiceRequest";

const jwkPublic = publicKey.export({ format: "jwk" });
const JWKS: Jwks = {
  keys: [
    {
      kid: KID,
      alg: "RS256",
      use: "sig",
      kty: "RSA",
      n: jwkPublic.n as string,
      e: jwkPublic.e as string,
    },
  ],
};

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

interface SignOptions {
  alg?: string;
  kid?: string | null;
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  nbf?: number;
  jti?: string;
  extra?: Record<string, unknown>;
}

function signJwt(opts: SignOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {
    alg: opts.alg ?? "RS256",
    typ: "JWT",
  };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;
  const payload = {
    iss: opts.iss ?? ISS,
    sub: opts.sub ?? SUB,
    aud: opts.aud ?? AUD,
    iat: opts.iat ?? now,
    exp: opts.exp ?? now + 300,
    jti: opts.jti ?? "jti-1",
    ...(opts.nbf !== undefined ? { nbf: opts.nbf } : {}),
    ...(opts.extra ?? {}),
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const algo =
    opts.alg === "RS384"
      ? "RSA-SHA384"
      : opts.alg === "RS512"
        ? "RSA-SHA512"
        : "RSA-SHA256";
  const signer = createSign(algo);
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey);
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

describe("verifySmartJwt", () => {
  it("accepts a well-formed RS256 token", () => {
    const result = verifySmartJwt({
      token: signJwt(),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.jti).toBe("jti-1");
  });

  it("rejects malformed tokens", () => {
    const r = verifySmartJwt({
      token: "not.a.jwt",
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("malformed_token");
  });

  it("rejects HS256 (must be asymmetric)", () => {
    // We can't actually sign with HS256 via our helper, but we can
    // hand-craft a header with alg=HS256 and assert the verifier
    // rejects before signature checking.
    const headerB64 = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payloadB64 = base64UrlEncode(
      JSON.stringify({ iss: ISS, sub: SUB, aud: AUD, exp: 9_999_999_999, iat: 0, jti: "x" }),
    );
    const r = verifySmartJwt({
      token: `${headerB64}.${payloadB64}.AAAA`,
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unsupported_algorithm");
  });

  it("rejects missing kid", () => {
    const r = verifySmartJwt({
      token: signJwt({ kid: null }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing_kid");
  });

  it("rejects kid not in JWKS", () => {
    const r = verifySmartJwt({
      token: signJwt({ kid: "unknown-kid" }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("key_not_in_jwks");
  });

  it("rejects mismatched issuer / subject / audience", () => {
    const r1 = verifySmartJwt({
      token: signJwt({ iss: "https://wrong.example.com" }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("issuer_mismatch");

    const r2 = verifySmartJwt({
      token: signJwt({ sub: "wrong" }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("subject_mismatch");

    const r3 = verifySmartJwt({
      token: signJwt({ aud: "https://wrong/url" }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("audience_mismatch");
  });

  it("accepts an audience that's an array containing the expected value", () => {
    const r = verifySmartJwt({
      token: signJwt({ aud: ["https://other", AUD] }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects expired tokens", () => {
    const now = Math.floor(Date.now() / 1000);
    const r = verifySmartJwt({
      token: signJwt({ iat: now - 7200, exp: now - 100 }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
      iatWindowSeconds: 7200,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("token_expired");
  });

  it("rejects when jti is missing", () => {
    const r = verifySmartJwt({
      token: signJwt({ jti: "" }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing_jti");
  });

  it("rejects iat outside window", () => {
    const now = Math.floor(Date.now() / 1000);
    const r = verifySmartJwt({
      token: signJwt({ iat: now - 86400 }),
      jwks: JWKS,
      expectedIssuer: ISS,
      expectedSubject: SUB,
      expectedAudience: AUD,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("iat_outside_window");
  });
});
