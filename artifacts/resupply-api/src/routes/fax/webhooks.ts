// Telnyx fax webhook router — POST /inbound + POST /status-callback.
//
// Mounted in app.ts at /resupply-api/fax with express.raw() BEFORE the
// global express.json(), because Telnyx's Ed25519 signature is computed
// over the EXACT raw body bytes (same posture as the Stripe webhook).
// The requireTelnyxSignature middleware verifies over the raw Buffer and
// then replaces req.body with the parsed JSON event for the handlers.
//
// Inbound `fax.received` events arrive here via the Fax Application's
// configured webhook URL; outbound lifecycle events arrive here via the
// per-fax webhook_url override we set on dispatch (see telnyx-fax.ts).

import { Router, type IRouter } from "express";

import { requireTelnyxSignature } from "@workspace/resupply-telecom";

import { faxInboundHandler } from "./inbound.js";
import { faxStatusCallbackHandler } from "./status-callback.js";

const router: IRouter = Router();

// The public key is read from process.env per request (not captured when
// the middleware is constructed), so a changed process-level value takes
// effect without rebuilding the middleware. A key saved via System
// Configuration is a catalog key (applyMode: "restart"), so that path still
// only takes effect on the next deploy/restart, like the other Telnyx vars.
const telnyxSignature = requireTelnyxSignature({
  getPublicKey: () => process.env.TELNYX_PUBLIC_KEY,
});

router.post("/inbound", telnyxSignature, faxInboundHandler);
router.post("/status-callback", telnyxSignature, faxStatusCallbackHandler);

export default router;
