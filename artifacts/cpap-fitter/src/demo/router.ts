// The demo request router. Given an intercepted fetch, it normalizes
// the arguments, then walks the registered handlers (first match
// wins). Only same-origin API paths are handled; everything else
// (static assets, images, third-party, HMR) returns null so the
// caller passes it through to the real network.

import type { DemoHandler, DemoRequest, HttpMethod } from "./types";
import { json } from "./respond";
import { emptyGetFallbackBody } from "./empty";

import { authHandlers } from "./handlers/auth";
import { shopHandlers } from "./handlers/shop";
import { accountHandlers } from "./handlers/account";
import { fitflowHandlers } from "./handlers/fitflow";
import { miscHandlers } from "./handlers/misc";
import { adminHandlers } from "./handlers/admin";
import { therapyHandlers } from "./handlers/therapy";
import { billingClaimsHandlers } from "./handlers/billing-claims";
import { platformHandlers } from "./handlers/platform";
import { analyticsHandlers } from "./handlers/analytics";
import { advancedBillingHandlers } from "./handlers/advanced-billing";
import { clinicalHandlers } from "./handlers/clinical";
import { patientDetailHandlers } from "./handlers/patient-detail";
import { settingsHandlers } from "./handlers/settings";
import { integrationsCommsHandlers } from "./handlers/integrations-comms";
import { ext0Handlers } from "./handlers/ext0";
import { ext1Handlers } from "./handlers/ext1";
import { ext2Handlers } from "./handlers/ext2";
import { ext3Handlers } from "./handlers/ext3";
import { ext4Handlers } from "./handlers/ext4";
import { ext5Handlers } from "./handlers/ext5";
import { ext6Handlers } from "./handlers/ext6";
import { ext7Handlers } from "./handlers/ext7";
import { ext8Handlers } from "./handlers/ext8";
import { ext9Handlers } from "./handlers/ext9";
import { ext10Handlers } from "./handlers/ext10";
import { ext11Handlers } from "./handlers/ext11";
import { ext12Handlers } from "./handlers/ext12";
import { ext13Handlers } from "./handlers/ext13";
import { ext14Handlers } from "./handlers/ext14";
import { ext15Handlers } from "./handlers/ext15";
import { ext16Handlers } from "./handlers/ext16";
import { fittingReferralsHandlers } from "./handlers/fitting-referrals";

// Order matters only where patterns could overlap; within a surface
// the more specific routes are declared first in their module. The
// extended-coverage modules below seed the long tail of admin pages
// (analytics, advanced billing, clinical/RT worklists, patient detail,
// settings/control, integrations/comms/FHIR). They use distinct
// `/resupply-api/admin/...` (and `/resupply-api/fhir/...`) prefixes that
// don't overlap the core handlers above.
const handlers: DemoHandler[] = [
  ...authHandlers,
  ...accountHandlers,
  ...shopHandlers,
  ...fitflowHandlers,
  ...miscHandlers,
  // ext13 (patient records) must precede adminHandlers: its static
  // `GET /resupply-api/patients/duplicates` would otherwise be shadowed by
  // admin's `GET /resupply-api/patients/:id` param route (first-match wins).
  ...ext13Handlers,
  ...adminHandlers,
  ...therapyHandlers,
  ...billingClaimsHandlers,
  ...platformHandlers,
  ...analyticsHandlers,
  ...advancedBillingHandlers,
  ...clinicalHandlers,
  ...patientDetailHandlers,
  ...settingsHandlers,
  ...integrationsCommsHandlers,
  // Extended admin coverage (ext0–ext9): the long tail of admin console
  // pages — billing ops, CSR/conversation tools, clinical/patient
  // sub-resources, shop/storefront ops, integrations, providers, etc.
  // Each module owns a disjoint set of `/resupply-api/admin/...` paths.
  ...ext0Handlers,
  ...ext1Handlers,
  ...ext2Handlers,
  ...ext3Handlers,
  ...ext4Handlers,
  ...ext5Handlers,
  ...ext6Handlers,
  ...ext7Handlers,
  ...ext8Handlers,
  ...ext9Handlers,
  // Final coverage pass (ext10–ext16): SPA-facing storefront, patient
  // portal ("me-*"), patient records, conversations/episodes/provider
  // portal, and the rules engine. (ext13 is wired earlier, above admin.)
  ...ext10Handlers,
  ...ext11Handlers,
  ...ext12Handlers,
  ...ext14Handlers,
  ...ext15Handlers,
  ...ext16Handlers,
  // Fitting + referral surfaces (mask catalog, formulary, fit sessions,
  // safety screens, provider referrals, AI referral triage). Own the
  // `/admin/fitter/...`, `/admin/fit-sessions/...`,
  // `/admin/provider-referrals/...` and `/admin/referral-reviews/...`
  // prefixes, which no module above claims.
  ...fittingReferralsHandlers,
];

/** API paths the demo sandbox is responsible for answering. */
function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/resupply-api/") ||
    pathname === "/resupply-api"
  );
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return "GET";
}

async function resolveBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | null> {
  if (init && "body" in init && init.body != null) {
    if (typeof init.body === "string") return init.body;
    if (
      typeof URLSearchParams !== "undefined" &&
      init.body instanceof URLSearchParams
    ) {
      return init.body.toString();
    }
    // FormData / Blob / ArrayBuffer aren't used as bodies on the app's
    // API paths. Don't `String()` them — that yields "[object Object]",
    // which a handler's json() would then fail to parse. Treat as no
    // readable JSON body instead.
    return null;
  }
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

function parseUrl(url: string): URL {
  const origin =
    typeof window !== "undefined" && window.location
      ? window.location.origin
      : "http://localhost";
  try {
    return new URL(url, origin);
  } catch {
    return new URL(origin);
  }
}

function resolveHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((v, k) => headers.set(k, v));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  }
  return headers;
}

function buildDemoRequest(
  parsed: URL,
  url: string,
  method: string,
  headers: Headers,
  rawBody: string | null,
): DemoRequest {
  let cachedJson: unknown;
  let jsonParsed = false;
  return {
    method: method.toUpperCase() as HttpMethod,
    url,
    pathname: parsed.pathname,
    query: parsed.searchParams,
    headers,
    rawBody,
    json<T = unknown>(): T | undefined {
      if (!jsonParsed) {
        jsonParsed = true;
        if (rawBody) {
          try {
            cachedJson = JSON.parse(rawBody);
          } catch {
            cachedJson = undefined;
          }
        }
      }
      return cachedJson as T | undefined;
    },
  };
}

/**
 * Route an intercepted request. Returns a synthetic `Response` when
 * the demo sandbox owns the path, or `null` to let the caller fall
 * through to the real network (non-API paths only).
 */
export async function routeDemoRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response | null> {
  const url = resolveUrl(input);
  const parsed = parseUrl(url);

  // Gate on the path BEFORE touching headers/body: non-API requests
  // (assets, images, HMR, third-party) are the common case and must
  // pass straight through with no body clone or header copy.
  if (!isApiPath(parsed.pathname)) return null;

  const method = resolveMethod(input, init);
  const headers = resolveHeaders(input, init);
  const rawBody = await resolveBody(input, init);
  const req = buildDemoRequest(parsed, url, method, headers, rawBody);

  for (const handler of handlers) {
    if (handler.method !== req.method) continue;
    const params = handler.match(req.pathname);
    if (!params) continue;
    return handler.handle(req, params);
  }

  // Unmatched API path. Keep the sandbox self-contained: never let an
  // API call escape to a real backend in demo mode. Mutations report
  // success; reads return an "empty everything" shape so list pages fall
  // back to their empty states rather than throwing.
  //
  // HEAD carries no body per HTTP semantics — return a bodyless 200 so
  // callers that inspect Content-Length / streaming don't get confused.
  if (req.method === "HEAD") {
    return new Response(null, { status: 200 });
  }
  if (req.method === "GET") {
    if (import.meta.env.DEV) {
      console.debug("[demo] unmatched GET — empty fallback:", req.pathname);
    }
    return json(emptyGetFallbackBody(), 200);
  }
  if (import.meta.env.DEV) {
    console.debug(
      "[demo] unmatched mutation — ok fallback:",
      req.method,
      req.pathname,
    );
  }
  return json({ ok: true }, 200);
}
