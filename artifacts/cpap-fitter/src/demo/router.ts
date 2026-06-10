// The demo request router. Given an intercepted fetch, it normalizes
// the arguments, then walks the registered handlers (first match
// wins). Only same-origin API paths are handled; everything else
// (static assets, images, third-party, HMR) returns null so the
// caller passes it through to the real network.

import type { DemoHandler, DemoRequest, HttpMethod } from "./types";
import { json } from "./respond";

import { authHandlers } from "./handlers/auth";
import { shopHandlers } from "./handlers/shop";
import { accountHandlers } from "./handlers/account";
import { fitflowHandlers } from "./handlers/fitflow";
import { miscHandlers } from "./handlers/misc";
import { adminHandlers } from "./handlers/admin";
import { billingClaimsHandlers } from "./handlers/billing-claims";

// Order matters only where patterns could overlap; within a surface
// the more specific routes are declared first in their module.
const handlers: DemoHandler[] = [
  ...authHandlers,
  ...accountHandlers,
  ...shopHandlers,
  ...fitflowHandlers,
  ...miscHandlers,
  ...adminHandlers,
  ...billingClaimsHandlers,
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
  // success; reads return an empty object so list pages fall back to
  // their empty states rather than throwing.
  if (req.method === "GET" || req.method === "HEAD") {
    if (import.meta.env.DEV) {
      console.debug("[demo] unmatched GET — empty fallback:", req.pathname);
    }
    return json({}, 200);
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
