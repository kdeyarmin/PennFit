// requireSmartFhirAccess — auth gate for inbound SMART-on-FHIR
// Backend Services POSTs (Phase 4 of the inbound referral roadmap).
//
// The route handler at POST /fhir/r4/ServiceRequest is the only
// consumer for now; this middleware:
//
//   1. Extracts a Bearer JWT from the Authorization header.
//   2. Peeks at the `iss` claim (without verifying) to find the
//      matching ehr_fhir_tenants row.
//   3. Fetches the tenant's JWKS (cached in-process for 5 minutes
//      to avoid hammering the partner on every POST).
//   4. Verifies the JWT against the JWKS + the tenant's expected_*
//      claims and the audience URL we publish.
//   5. Attaches `req.fhirTenant` so the route handler can land the
//      payload under source = `ehr_fhir_<slug>`.
//
// On any failure → 401 with a tagged reason.
//
// PHI posture: the request body is NOT consumed here (the route's
// express.raw() runs after this). Logger sees only the tenant slug
// + JWT verification outcome, never the token contents.

import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  type Jwks,
  type VerifyFailureReason,
  fetchJwks,
  verifySmartJwt,
} from "@workspace/resupply-integrations-ehr-fhir";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../lib/logger";
import {
  assertSafeOutboundHost,
  assertSafeOutboundUrlSync,
  fetchWithPinnedIp,
} from "../lib/safe-outbound";

// SSRF-safe fetch wrapper for JWKS retrieval. `jwks_uri` lives in
// `ehr_fhir_tenants.jwks_uri` and is set during partner onboarding;
// a careless or compromised admin could point it at 127.0.0.1 or
// the AWS metadata endpoint at 169.254.169.254, turning every SMART
// auth check into an SSRF probe of internal infrastructure. The
// fetcher (a) refuses non-https URLs, (b) refuses literal IPs in
// private/reserved ranges, (c) resolves DNS and refuses if any
// resolved A/AAAA record points at internal space, and (d) pins the
// connection to the resolved IP so DNS rebinding can't sneak through.
async function safeJwksFetch(url: string): Promise<globalThis.Response> {
  // Use the global Response type (not the express.Response that
  // `Response` would resolve to inside this module).
  const parsed = assertSafeOutboundUrlSync(url);
  const safeIp = await assertSafeOutboundHost(parsed.hostname);
  return fetchWithPinnedIp(fetch, url, safeIp, parsed.hostname);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      fhirTenant?: {
        id: string;
        slug: string;
        displayName: string;
      };
    }
  }
}

interface JwksCacheEntry {
  jwks: Jwks;
  expiresAt: number;
}

const JWKS_CACHE = new Map<string, JwksCacheEntry>();
const JWKS_TTL_MS = 5 * 60 * 1000;

/** Reset hook for tests. */
export function __resetSmartFhirJwksCache(): void {
  JWKS_CACHE.clear();
}

/**
 * Get the public URL the tenant's JWT must claim as `aud`. We
 * derive this from RESUPPLY_VOICE_PUBLIC_BASE_URL (the same env
 * var the rest of the public-callback surface uses). When unset
 * we refuse the request — the audience is part of the security
 * contract and we cannot fall back to a guess.
 */
function getExpectedAudience(): string | null {
  const base =
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.replace(/\/+$/u, "") ?? null;
  if (!base) return null;
  return `${base}/fhir/r4/ServiceRequest`;
}

export const requireSmartFhirAccess: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const auth = req.header("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing_bearer" });
    return;
  }
  const token = auth.slice(7).trim();
  if (token.length === 0) {
    res.status(401).json({ error: "missing_bearer" });
    return;
  }
  const audience = getExpectedAudience();
  if (!audience) {
    logger.warn(
      { event: "smart_fhir_audience_unconfigured" },
      "requireSmartFhirAccess: RESUPPLY_VOICE_PUBLIC_BASE_URL unset",
    );
    res.status(503).json({ error: "fhir_endpoint_unconfigured" });
    return;
  }

  // Peek at the JWT's iss claim WITHOUT verifying, so we can find
  // the matching tenant row. The full verify (signature + claims)
  // happens below.
  const issClaim = peekIssClaim(token);
  if (!issClaim) {
    res.status(401).json({ error: "malformed_token" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: tenant, error: tenantErr } = await supabase
    .schema("resupply")
    .from("ehr_fhir_tenants")
    .select("id, slug, display_name, jwks_uri, audience, expected_issuer, expected_subject")
    .eq("expected_issuer", issClaim)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (tenantErr) {
    logger.error(
      { err: tenantErr.message },
      "requireSmartFhirAccess: tenant lookup failed",
    );
    res.status(503).json({ error: "tenant_lookup_failed" });
    return;
  }
  if (!tenant) {
    res.status(401).json({ error: "unknown_issuer" });
    return;
  }
  // Defence in depth: if the tenant's `audience` column has been
  // explicitly set, prefer it over the env-derived default. Lets us
  // rotate the public URL without a code change.
  const expectedAudience = tenant.audience || audience;

  let jwks: Jwks;
  try {
    jwks = await getJwksCached(tenant.jwks_uri);
  } catch (err) {
    logger.warn(
      {
        tenant_slug: tenant.slug,
        err: err instanceof Error ? err.message : String(err),
      },
      "requireSmartFhirAccess: jwks fetch failed",
    );
    res.status(503).json({ error: "jwks_unavailable" });
    return;
  }

  let verifyOutcome = verifySmartJwt({
    token,
    jwks,
    expectedIssuer: tenant.expected_issuer,
    expectedSubject: tenant.expected_subject,
    expectedAudience,
  });
  // On signature_invalid / key_not_in_jwks the tenant may have
  // rotated their signing key since we cached the JWKS. Evict and
  // re-fetch once before giving up — without this, the old JWKS
  // can be served for up to JWKS_TTL_MS after rotation, which is
  // the exact window where a compromised pre-rotation private
  // key could still be accepted.
  if (
    !verifyOutcome.ok &&
    (verifyOutcome.reason === "signature_invalid" ||
      verifyOutcome.reason === "key_not_in_jwks")
  ) {
    JWKS_CACHE.delete(tenant.jwks_uri);
    try {
      jwks = await getJwksCached(tenant.jwks_uri);
      verifyOutcome = verifySmartJwt({
        token,
        jwks,
        expectedIssuer: tenant.expected_issuer,
        expectedSubject: tenant.expected_subject,
        expectedAudience,
      });
    } catch (err) {
      logger.warn(
        {
          tenant_slug: tenant.slug,
          err: err instanceof Error ? err.message : String(err),
        },
        "requireSmartFhirAccess: jwks re-fetch after signature_invalid failed",
      );
    }
  }
  if (!verifyOutcome.ok) {
    logSmartVerifyFailure(tenant.slug, verifyOutcome.reason);
    res.status(401).json({
      error: "jwt_invalid",
      reason: verifyOutcome.reason,
    });
    return;
  }

  req.fhirTenant = {
    id: tenant.id,
    slug: tenant.slug,
    displayName: tenant.display_name,
  };
  next();
};

async function getJwksCached(jwksUri: string): Promise<Jwks> {
  const now = Date.now();
  const cached = JWKS_CACHE.get(jwksUri);
  if (cached && cached.expiresAt > now) {
    return cached.jwks;
  }
  const jwks = await fetchJwks(jwksUri, { fetchImpl: safeJwksFetch });
  JWKS_CACHE.set(jwksUri, { jwks, expiresAt: now + JWKS_TTL_MS });
  return jwks;
}

function peekIssClaim(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    if (payload && typeof payload === "object" && typeof payload.iss === "string") {
      return payload.iss;
    }
  } catch {
    return null;
  }
  return null;
}

function logSmartVerifyFailure(
  tenantSlug: string,
  reason: VerifyFailureReason,
): void {
  logger.warn(
    { tenant_slug: tenantSlug, reason },
    "requireSmartFhirAccess: jwt verify failed",
  );
}
