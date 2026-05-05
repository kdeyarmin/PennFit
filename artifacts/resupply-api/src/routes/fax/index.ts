// Fax routes — /fax/document/:token, /fax/status-callback.
//
// Both routes are mounted unconditionally (same pattern as voice/sms):
//   * /fax/document/:token  — serves the cover-letter PDF for Twilio
//                             to transmit; signed token gate prevents
//                             unauthenticated PHI access.
//   * /fax/status-callback  — Twilio delivery lifecycle webhook;
//                             Twilio signature required.

import { Router, type IRouter } from "express";

import documentRouter from "./document.js";
import statusCallbackRouter from "./status-callback.js";

const router: IRouter = Router();
router.use(documentRouter);
router.use(statusCallbackRouter);

export default router;
