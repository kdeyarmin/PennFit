// POST /voice/checkin-twiml — Twilio call-answered webhook for the
// automated onboarding check-in calls placed by the multi-channel
// dispatcher.
//
// Unlike /voice/twiml-connect (which bridges a real-time AI agent
// over a Media Stream), this endpoint serves a one-way scripted
// message — Twilio's <Say> reads the day-X check-in aloud, then
// <Hangup>. Patients who want to reach a human are directed to
// reply to the SMS or call the office back.
//
// Why no Media Stream / WS bridge:
//   Day-3/7/30/60/90 nudges are pure outreach — there's no
//   conversation expected. A WS-bridged AI agent costs ~$0.30/min
//   in OpenAI tokens; a one-shot <Say> costs the Twilio call cost
//   alone. For 10k patients/quarter the difference is meaningful,
//   and the value-add of the agent on a one-way nudge is near zero.
//
// Twilio signature is verified — this endpoint is referenced from
// public TwiML URLs we hand to Twilio at placeCall time, so anyone
// with the URL could otherwise probe it.

import { Router, type IRouter, type Request } from "express";

import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { voiceScriptForDay } from "../../lib/checkin-dispatcher";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import type { OnboardingDayLabel } from "@workspace/resupply-db";

const router: IRouter = Router();

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readVoiceConfigOrNull()?.twilioAuthToken,
  buildPublicUrl: (req) => {
    const cfg = readVoiceConfigOrNull();
    const base = cfg?.publicBaseUrl ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

const VALID_DAYS: ReadonlyArray<OnboardingDayLabel> = [
  "day3",
  "day7",
  "day30",
  "day60",
  "day90",
];

router.post(
  "/voice/checkin-twiml",
  signatureMiddleware,
  (req: Request, res) => {
    const dayRaw = (req.query["day"] ?? "").toString();
    const day = (VALID_DAYS as readonly string[]).includes(dayRaw)
      ? (dayRaw as OnboardingDayLabel)
      : "day7";
    const script = voiceScriptForDay(day);

    res
      .status(200)
      .type("application/xml")
      .send(
        [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<Response>`,
          `  <Say voice="Polly.Joanna">${escapeXmlText(script)}</Say>`,
          `  <Pause length="1"/>`,
          `  <Hangup/>`,
          `</Response>`,
        ].join("\n"),
      );
  },
);

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default router;
