// /admin/diagnostics/proxy-chain — echo what the proxy chain actually
// delivered to the app for THIS request, so an operator can validate
// Railway forwarding behavior and diagnose `req.ip` resolution under
// the current `trust proxy` configuration.
//
//   GET /admin/diagnostics/proxy-chain
//
// Returns, for the calling request only:
//   - the immediate TCP peer (req.socket.remoteAddress) — which proxy
//     actually connected to us,
//   - the raw forwarding headers as received (X-Forwarded-For/-Proto/-Host,
//     X-Real-IP),
//   - Express's resolution of them under the CURRENT `trust proxy`
//     setting (req.ip, req.ips, req.protocol, req.hostname).
//
// Gating: `system.config.manage` (super-admin), same as the rest of the
// System Configuration diagnostics. Read-only, touches no vendor and no DB.
//
// Log posture: nothing is logged. The values are the calling operator's
// own connection metadata, returned to that operator only — IPs never
// reach the application logger (every log line is world-readable).

import { Router, type IRouter } from "express";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
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
