import type { NextFunction, Request, Response } from "express";

/**
 * Tight security-headers middleware for the resupply API.
 *
 * Why hand-rolled instead of `helmet`:
 *   The API serves JSON, not HTML. Helmet's defaults set a Content-
 *   Security-Policy, X-XSS-Protection, and a handful of HTML-only
 *   header families that don't apply to a JSON Bearer-token API and
 *   only add noise to response logs. The set below is exactly what
 *   matters for a credentialed JSON service behind HTTPS, with one
 *   line of justification each.
 *
 * Set on every response:
 *   * Strict-Transport-Security: 1-year, includeSubDomains. We ONLY
 *     emit this when the request is recognized as HTTPS (either
 *     `req.secure` or X-Forwarded-Proto: https from the reverse
 *     proxy) — emitting it on a plain-HTTP dev/test request would
 *     either be ignored by the browser or, worse, force a future
 *     dev-mode http://localhost reload to fail.
 *   * X-Content-Type-Options: nosniff. Stops a downstream consumer
 *     from MIME-sniffing a JSON response into something else.
 *   * X-Frame-Options: DENY. The API has no embeddable HTML; if a
 *     future endpoint accidentally returns HTML, no frame from
 *     anywhere can render it.
 *   * Referrer-Policy: strict-origin-when-cross-origin. The API's
 *     URLs may carry patient ids in :id segments — never let those
 *     leak to a third-party origin via Referer.
 *   * Cross-Origin-Opener-Policy: same-origin. Defense-in-depth
 *     against window.opener-style attacks if a future error page
 *     ever serves HTML.
 *   * Cross-Origin-Resource-Policy: same-origin. Stops cross-origin
 *     <img>/<script> tags from loading API responses as resources.
 *   * Permissions-Policy: minimal, EXCEPT camera=(self) and
 *     microphone=(self). Since the May 2026 consolidation this process
 *     also serves the cpap-fitter SPA's HTML; the face-scan capture
 *     page calls getUserMedia({video}) and the telehealth video-visit
 *     page calls getUserMedia({video, audio}) — an empty allowlist on
 *     the top-level document makes Chromium reject it with
 *     NotAllowedError regardless of the user's permission grant (this
 *     is what broke the production face-scan, see
 *     docs/app-review-2026-06-10.md P0-1, and later the video visit
 *     via microphone=()). Same-origin only; everything else stays
 *     denied.
 *   * X-DNS-Prefetch-Control: off. Don't preemptively resolve DNS
 *     for any links the response body might contain — same
 *     leak-prevention reasoning as Referrer-Policy.
 *
 * Deliberately NOT set:
 *   * Content-Security-Policy: this is a JSON API; CSP belongs on
 *     the SPA HTML, served by the static host.
 *   * X-XSS-Protection: deprecated header that modern browsers
 *     ignore; setting it gives a false sense of security.
 */

function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const xfp = req.get("x-forwarded-proto");
  if (typeof xfp === "string" && xfp.toLowerCase().includes("https")) {
    return true;
  }
  return false;
}

export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // HSTS — only in HTTPS contexts (see header doc).
  if (isHttps(req)) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(self), camera=(self), payment=(), usb=()",
  );
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
}
