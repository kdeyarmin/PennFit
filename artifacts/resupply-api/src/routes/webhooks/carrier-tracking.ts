// POST /resupply-api/webhooks/carrier — carrier tracking webhook.
//
// Mounted in app.ts with express.raw() BEFORE the global express.json(), so the
// HMAC signature can be verified over the exact bytes the carrier sent. Accepts
// EasyPost/Shippo-style tracker pushes (or any HMAC-signed `{tracking_number,
// status}`) and advances the matching shop_order's shipped_at / delivered_at,
// firing the same patient-packet auto-send the admin "mark delivered" route runs.
//
// Contract: 503 when unconfigured (no secret) so dev/preview never needs it;
// 401 on a bad signature once configured (fail-closed); 200 otherwise (incl.
// unmatched / non-actionable events) so the carrier stops retrying.

import { Router, type IRouter, type Request, type Response } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";

import { logger } from "../../lib/logger";
import { RATE_LIMITS } from "../../lib/rate-limits-config";
import {
  applyCarrierTrackingEvent,
  parseCarrierEvent,
  readCarrierWebhookConfigOrNull,
  verifyCarrierSignature,
} from "../../lib/shipping/carrier-tracking";

const router: IRouter = Router();

// IP-keyed rate limiter on the unauthenticated webhook endpoint. The HMAC
// signature check is the primary authorisation gate, but we still want a
// recognised throttle in front (CodeQL `js/missing-rate-limiting`) so a flood
// of forged requests can't burn CPU on signature math. 300/min/IP is well
// above carrier push volume.
const carrierWebhookRateLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.carrier_inbound_webhook.windowMs,
  limit: RATE_LIMITS.carrier_inbound_webhook.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

// Mounted at /resupply-api/webhooks/carrier (app.ts), so the path here is root.
router.post(
  "/",
  carrierWebhookRateLimiter,
  async (req: Request, res: Response) => {
    const config = readCarrierWebhookConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "carrier_webhook_not_configured" });
      return;
    }
    // express.raw() leaves req.body as a Buffer; fall back defensively.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : "");
    const signature =
      req.header("x-carrier-signature") ?? req.header("x-hmac-signature");
    if (!verifyCarrierSignature(rawBody, signature, config.secret)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid_json" });
      return;
    }

    const event = parseCarrierEvent(payload);
    if (!event) {
      // Recognized + authentic but nothing to act on — ACK so the carrier
      // doesn't retry.
      res.json({ ok: true, matched: false, updated: false });
      return;
    }

    const result = await applyCarrierTrackingEvent(event);
    logger.info(
      {
        event: "carrier_tracking.ingested",
        status: event.status,
        matched: result.matched,
        updated: result.updated,
      },
      "carrier-tracking: event ingested",
    );
    res.json({ ok: true, ...result });
  },
);

export default router;
