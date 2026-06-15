// POST /voice/connection-test-twiml — TwiML for the super-admin
// "test voice connection" button on /admin/system/configuration.
//
// When a super-admin triggers a voice connection test, the API places
// an outbound call (see lib/connection-tests/runners.ts → runVoiceTest)
// pointing Twilio at THIS url. Twilio fetches it when the callee
// answers; we return a static Say + Hangup confirming the integration
// works. No patient context, no Media Stream, no AI bridge — the whole
// point is to prove the Twilio voice path end-to-end with nothing else
// wired.
//
// Twilio-signed like every other inbound voice webhook: the signature
// middleware reconstructs the URL from the public base URL + path and
// rejects anything not signed with TWILIO_AUTH_TOKEN. The token is read
// at request time so secret rotation needs no restart.

import { Router, type IRouter } from "express";

import {
  buildHangupTwiml,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { TEST_VOICE_MESSAGE } from "../../lib/connection-tests/runners";
import {
  readTwilioWebhookAuthTokenOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

const router: IRouter = Router();

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    const originalUrl = req.originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post(
  "/voice/connection-test-twiml",
  signatureMiddleware,
  (_req, res) => {
    res.status(200).type("text/xml").send(buildHangupTwiml(TEST_VOICE_MESSAGE));
  },
);

export default router;
