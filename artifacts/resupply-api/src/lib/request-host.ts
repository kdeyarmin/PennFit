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
 * value if present (proxy-forwarded), else the `Host` header. Port and
 * surrounding whitespace are stripped; an absent host yields "".
 */
export function requestHost(req: Pick<Request, "headers">): string {
  const fwd = req.headers["x-forwarded-host"];
  const raw = Array.isArray(fwd) ? fwd[0] : (fwd ?? req.headers.host);
  const first = (typeof raw === "string" ? raw : "").split(",")[0] ?? "";
  return first.trim().toLowerCase();
}
