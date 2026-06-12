// /admin/diagnostics/proxy-chain — echo what the proxy chain actually
// delivered to the app for THIS request, so an operator can validate
// Railway/Cloudflare forwarding behavior and diagnose `req.ip` resolution
// under the current `trust proxy` configuration (P1-5; capture procedure
// in docs/runbooks/verify-xff-chain.md).
//
//   GET /admin/diagnostics/proxy-chain
//
// Returns, for the calling request only:
//   - the immediate TCP peer (req.socket.remoteAddress) — which proxy
//     actually connected to us,
//   - the raw forwarding headers as received (X-Forwarded-For/-Proto/
//     -Host, X-Real-IP, and Cloudflare's CF-Connecting-IP / CF-Ray /
//     True-Client-IP),
//   - Express's resolution of them under the CURRENT `trust proxy`
//     setting (req.ip, req.ips, req.protocol, req.hostname).
//
// Hitting this once via the custom domain (Cloudflare-fronted) and once
// via *.up.railway.app — and once more each with a forged
// `X-Forwarded-For: 9.9.9.9` — answers the questions the fix depends
// on: hop count per host, and whether Railway strips or appends a
// client-supplied XFF.
//
// Gating: `system.config.manage` (super-admin), same as the rest of the
// System Configuration diagnostics. Read-only, touches no vendor and no
// DB.
//
// Log posture: nothing is logged. The values are the calling operator's
// own connection metadata, returned to that operator only — IPs never
// reach the application logger (every log line is world-readable).

import { Router, type IRouter } from "express";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// The forwarding headers worth capturing. Cloudflare sets the cf-*
// pair and true-client-ip (Enterprise); Railway's edge owns the
// x-forwarded-* family; x-real-ip covers nginx-style proxies in case
// the chain ever changes.
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "true-client-ip",
] as const;

router.get(
  "/admin/diagnostics/proxy-chain",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  (req, res) => {
    const headers: Record<string, string | null> = {};
    for (const name of FORWARDING_HEADERS) {
      const value = req.headers[name];
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? null);
    }

    const trustProxySetting = req.app.get("trust proxy");
    const trustProxy =
      typeof trustProxySetting === "function"
        ? "[function]"
        : (trustProxySetting ?? null);

    res.json({
      capturedAt: new Date().toISOString(),
      host: req.headers.host ?? null,
      socket: {
        remoteAddress: req.socket.remoteAddress ?? null,
        remoteFamily: req.socket.remoteFamily ?? null,
      },
      headers,
      expressResolution: {
        trustProxy,
        ip: req.ip ?? null,
        ips: req.ips,
        protocol: req.protocol,
        hostname: req.hostname ?? null,
      },
    });
  },
);

export default router;
