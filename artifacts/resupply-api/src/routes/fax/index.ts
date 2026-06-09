// Fax routes — the GET document route only.
//
//   * /fax/document/:token  — serves the cover-letter PDF for Telnyx to
//                             transmit; HMAC-signed token gate.
//
// The two Telnyx webhook routes (/fax/inbound, /fax/status-callback) are
// NOT mounted here. They need the raw request body for Ed25519 signature
// verification, so they're mounted directly on the app in app.ts (with
// express.raw, before express.json) via routes/fax/webhooks.ts — the
// same pattern as the Stripe webhook.

import { Router, type IRouter } from "express";

import documentRouter from "./document.js";

const router: IRouter = Router();
router.use(documentRouter);

export default router;
