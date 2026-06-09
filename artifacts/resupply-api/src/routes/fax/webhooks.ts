// Telnyx fax webhook router — POST /webhook (unified) plus the legacy
// POST /inbound and POST /status-callback aliases.
//
// Mounted in app.ts at /resupply-api/fax with express.raw() BEFORE the
// global express.json(), because Telnyx's Ed25519 signature is computed
// over the EXACT raw body bytes (same posture as the Stripe webhook).
// The requireTelnyxSignature middleware verifies over the raw Buffer and
// then replaces req.body with the parsed JSON event for the handlers.
//
// The unified /webhook endpoint serves BOTH directions: inbound
// `fax.received` events and outbound delivery-status events arrive at the
// same URL and are told apart by event_type. The two legacy routes stay
// mounted so the Fax Application's connection webhook URL (set in the
// Telnyx portal) and any in-flight outbound faxes whose per-fax
// webhook_url still points at /status-callback keep working until they're
// converged onto /webhook.

import { Router, type IRouter, type Request, type Response } from "express";

import {
  parseTelnyxFaxEvent,
  requireTelnyxSignature,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger.js";
import { faxInboundHandler, processInboundFaxEvent } from "./inbound.js";
import {
  faxStatusCallbackHandler,
  processOutboundFaxEvent,
} from "./status-callback.js";

const router: IRouter = Router();

// The public key is read from process.env per request (not captured when
// the middleware is constructed), so a changed process-level value takes
// effect without rebuilding the middleware. A key saved via System
// Configuration is a catalog key (applyMode: "restart"), so that path still
// only takes effect on the next deploy/restart, like the other Telnyx vars.
const telnyxSignature = requireTelnyxSignature({
  getPublicKey: () => process.env.TELNYX_PUBLIC_KEY,
});

/**
 * Unified handler for POST /fax/webhook. ONE URL serving both inbound
 * receives and outbound delivery-status events. Telnyx tells them apart
 * by event_type — `fax.received` is inbound; every other lifecycle event
 * (queued / media.processed / sending.started / delivered / failed) is
 * outbound status. Signature already verified by the upstream
 * requireTelnyxSignature middleware; by here `req.body` is parsed JSON.
 */
export async function faxWebhookHandler(
  req: Request,
  res: Response,
): Promise<void> {
  // ACK immediately — Telnyx retries on non-2xx. Express awaits this
  // handler, so a post-ACK throw is captured by the error middleware
  // rather than surfacing as an unhandled rejection.
  res.status(200).json({ received: true });

  const parsed = parseTelnyxFaxEvent(req.body);
  if (!parsed.ok) {
    logger.warn(
      { event: "fax_webhook_malformed" },
      "fax/webhook: event missing event_type/fax_id",
    );
    return;
  }

  const event = parsed.event;
  if (event.eventType === "fax.received") {
    await processInboundFaxEvent(event);
  } else {
    await processOutboundFaxEvent(event);
  }
}

// Canonical unified endpoint.
router.post("/webhook", telnyxSignature, faxWebhookHandler);
// Legacy aliases (see file header) — identical logic, kept for a
// zero-downtime migration onto /webhook.
router.post("/inbound", telnyxSignature, faxInboundHandler);
router.post("/status-callback", telnyxSignature, faxStatusCallbackHandler);

export default router;
