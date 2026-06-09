// Voice routes — /voice/place-call, /voice/twiml-connect,
// /voice/status-callback. The actual WS upgrade for
// /voice/stream is wired in `src/index.ts` because it lives on the
// HTTP server, not the Express router.
//
// These three routes are mounted unconditionally — each handler does
// its own feature-flag check (so a single 503 reply tells admins
// exactly which env var is missing). That avoids a class of subtle
// "routes vanished after deploy" bug where a missing env var would
// silently demote a 503 into a generic 404.

import { Router, type IRouter } from "express";

import alertTwimlRouter from "./alert-twiml";
import checkinTwimlRouter from "./checkin-twiml";
import connectionTestTwimlRouter from "./connection-test-twiml";
import inboundReorderRouter from "./inbound-reorder";
import placeCallRouter from "./place-call";
import realtimeDiagnosticRouter from "./realtime-diagnostic";
import statusCallbackRouter from "./status-callback";
import twimlConnectRouter from "./twiml-connect";
import clickToDialTwimlRouter from "./click-to-dial-twiml";

const router: IRouter = Router();
router.use(placeCallRouter);
router.use(twimlConnectRouter);
router.use(statusCallbackRouter);
// /voice/click-to-dial-twiml — bridge leg of CSR click-to-dial (#11):
// fetched when the agent answers, <Dial>s the patient to connect them.
router.use(clickToDialTwimlRouter);
// /voice/alert-twiml — speaks an automated alert call's rendered
// transcript (stashed by lib/alerts/dispatch under an opaque ref so
// the text never rides the webhook URL). <Say> + <Hangup>, no bridge.
router.use(alertTwimlRouter);
// /voice/checkin-twiml — TwiML for automated onboarding check-in
// calls (day 3 / 7 / 30 / 60 / 90). Twilio fetches this when the
// patient answers; we render <Say> + <Hangup> based on ?day=<label>.
router.use(checkinTwimlRouter);
// /voice/inbound-reorder — AI-powered inbound reorder IVR.
// Identifies the caller by phone, persists a session, hands off to
// the OpenAI Realtime bridge for a conversation; unidentified
// callers transfer to a human.
router.use(inboundReorderRouter);
// /voice/connection-test-twiml — static Say + Hangup served to Twilio
// for the super-admin "test voice connection" diagnostic call.
router.use(connectionTestTwimlRouter);
// /voice/realtime-diagnostic — no-patient AI-bridge connection test. Dial
// in to validate the live Realtime voice path (e.g. the gpt-realtime-2 GA
// spike) without a patient record. Gated by OPENAI_REALTIME_DIAGNOSTIC_ENABLED
// (off by default) + Twilio signature.
router.use(realtimeDiagnosticRouter);

export default router;
