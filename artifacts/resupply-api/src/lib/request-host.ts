// Bare lowercase request host, honoring the proxy-forwarded host.
//
// The app runs behind reverse proxies, so the browser-visible host can arrive
// in `X-Forwarded-Host`, not `Host`. Tenant resolution (host → org_id / branding)
// keys off this value, so every caller must read it the same way — hence one
// shared helper instead of per-route copies that were drifting apart.

import type { Request } from "express";

type HostInput = Pick<Request, "headers"> & Partial<Pick<Request, "hostname">>;

/**
 * The bare lowercase host for a request. Prefers Express's
 * trust-proxy-aware `req.hostname`: `app.set("trust proxy", …)` installs the
 * same Cloudflare/Railway CIDR predicate that governs `req.ip`, so Express
 * honors `X-Forwarded-Host` ONLY when the request actually arrived through a
 * trusted proxy hop. For legitimate proxied traffic this resolves to exactly
 * the same value the raw header read produced; for a direct/forged
 * connection it falls back to the real `Host` instead of a client-supplied
 * `X-Forwarded-Host`.
 *
 * Why this matters: the host SELECTS THE TENANT (`resolveOrgIdByHost`) for
 * every public/storefront route, so trusting a raw, client-settable
 * `X-Forwarded-Host` would let a request file a lead/order under — or brand
 * outbound mail as — an arbitrary victim tenant. Gating on the proxy chain
 * (which the codebase already does for `req.ip`) closes that vector.
 *
 * Surrounding whitespace and any `:port` suffix are stripped; an absent host
 * yields "". Stripping the port keeps host→tenant resolution consistent for
 * callers that don't subsequently run the value through
 * `normalizeCustomDomain` — e.g. `Host: example.com:443` must resolve the
 * same tenant as `example.com`.
 */
export function requestHost(req: HostInput): string {
  // Express computes `hostname` from `X-Forwarded-Host` only when the
  // connection peer is a trusted proxy (else from `Host`); it already
  // strips the port. Callers in production always pass the full `req`.
  const hostname = typeof req.hostname === "string" ? req.hostname : "";
  if (hostname) return stripPort(hostname.trim().toLowerCase());

  // Fallback for contexts without a computed hostname (e.g. unit tests that
  // pass a bare `{ headers }`): the historical raw-header read.
  const fwd = req.headers["x-forwarded-host"];
  const raw = Array.isArray(fwd) ? fwd[0] : (fwd ?? req.headers.host);
  const first = (typeof raw === "string" ? raw : "").split(",")[0] ?? "";
  return stripPort(first.trim().toLowerCase());
}

/**
 * Strip a `:port` suffix from a host. Leaves IPv6 literals intact: a
 * bracketed `[::1]:443` keeps `[::1]`, and a bare `[::1]` (no port) is
 * unchanged — only the trailing `:digits` after the bracket is removed.
 */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    // IPv6 literal: host is `[addr]` optionally followed by `:port`.
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(0, close + 1);
  }
  // host:port — strip only a trailing all-digits port (a bare IPv6
  // address without brackets contains multiple colons and is left alone).
  return host.replace(/:\d+$/, "");
}
