// Bare lowercase request host, honoring the proxy-forwarded host.
//
// The app runs behind Cloudflare + Railway (two proxy hops), so the
// browser-visible host arrives in `X-Forwarded-Host`, not `Host`. Tenant
// resolution (host → org_id / branding) keys off this value, so every
// caller must read it the same way — hence one shared helper instead of
// the per-route copies that were drifting apart.

import type { Request } from "express";

/**
 * The bare lowercase host for a request: the first `X-Forwarded-Host`
 * value if present (proxy-forwarded), else the `Host` header. Surrounding
 * whitespace and any `:port` suffix are stripped; an absent host yields "".
 *
 * Stripping the port keeps host→tenant resolution consistent for callers
 * that don't subsequently run the value through `normalizeCustomDomain`
 * (which also strips it) — e.g. a `Host: example.com:443` must resolve the
 * same tenant as `example.com`.
 */
export function requestHost(req: Pick<Request, "headers">): string {
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
