// GET/POST /voice/alert-twiml — TwiML webhook for automated alert
// phone calls placed by the alert library (lib/alerts/dispatch.ts).
//
// Flow:
//   1. dispatchAlert renders the alert's voice transcript, stashes it
//      under an opaque `ref` in the in-process AlertVoiceScripts store,
//      and dials Twilio with url=/voice/alert-twiml?ref=<ref>.
//   2. The patient answers → Twilio fetches this endpoint.
//   3. We CLAIM the script by ref (consumes it — a ref speaks once) and
//      return a <Say> + <Hangup> TwiML document.
//   4. On a miss (expired / unknown ref) we return a neutral hangup so
//      a leaked or stale ref reveals nothing.
//
// Why the transcript rides a server-side ref and not the URL:
//   The rendered text is patient-specific and may quote PHI-shaped
//   content. Putting it in the webhook URL would leak it into Twilio's
//   request logs. The ref is an opaque UUID; the text lives only in
//   our process memory for a few minutes.
//
// Like the check-in TwiML, this uses Twilio's built-in <Say> rather
// than the Media-Streams bridge — a one-way spoken notification costs
// ~$0.013/min vs the realtime bridge's ~$0.30/min, and an alert needs
// no conversation.
//
// Twilio signature is verified — the endpoint is public and without
// verification anyone with a ref could trigger a <Say>.

import { Router, type IRouter, type Request } from "express";

import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { getAlertVoiceScripts } from "../../lib/alerts/voice-scripts";
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

function renderHangup(spoken?: string): string {
  const say = spoken
    ? `  <Say voice="Polly.Joanna">${escapeXmlText(spoken)}</Say>\n`
    : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    say + `  <Hangup/>`,
    `</Response>`,
  ].join("\n");
}

function handle(req: Request, res: import("express").Response): void {
  const ref = (req.query["ref"] ?? "").toString();
  const entry = ref ? getAlertVoiceScripts().claim(ref) : null;
  if (!entry) {
    // Unknown / expired / already-spoken ref — neutral hangup.
    res
      .status(200)
      .type("application/xml")
      .send(
        renderHangup(
          "We're sorry, this message is no longer available. Goodbye.",
        ),
      );
    return;
  }
  res.status(200).type("application/xml").send(renderHangup(entry.spokenText));
}

// Twilio POSTs by default, but allow GET too (placeCall's url is
// fetched however the account is configured).
router.post("/voice/alert-twiml", signatureMiddleware, handle);
router.get("/voice/alert-twiml", signatureMiddleware, handle);

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default router;
