// Fax routes — /fax/document/:token, /fax/status-callback,
//              /fax/inbound.
//
// All routes are mounted unconditionally (same pattern as voice/sms):
//   * /fax/document/:token  — serves the cover-letter PDF for Twilio
//                             to transmit; HMAC-signed token gate.
//   * /fax/status-callback  — Twilio outbound delivery lifecycle webhook.
//   * /fax/inbound          — Twilio inbound fax webhook (physician
//                             fax-backs); audit-only, no PHI stored.

import { Router, type IRouter } from "express";

import documentRouter from "./document.js";
import inboundRouter from "./inbound.js";
import statusCallbackRouter from "./status-callback.js";

const router: IRouter = Router();
router.use(documentRouter);
router.use(statusCallbackRouter);
router.use(inboundRouter);

export default router;
