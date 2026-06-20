// POST /voice/inbound-breathe-sales
//
// AI-powered inbound SALES line for the CareMetric Breathe *platform* (the
// B2B SaaS), distinct from the patient "Reorder Line" (inbound-reorder.ts).
// A prospective DME business dials the dedicated platform sales number; Twilio
// routes the call here. We:
//
//   1. Confirm the called number is the configured sales number.
//   2. Confirm the `voice.breathe_sales` feature flag is enabled.
//   3. Register a pending session (callerKind "breathe_prospect", no patient,
//      no tenant org, no `conversations` row) and return TwiML that opens a
//      Media Stream to the dedicated sales bridge handler.
//
// Unlike the reorder line, there is NO caller-by-phone identification, NO
// voice_reorder_sessions row, and NO tenant branding — the agent represents
// the CareMetric Breathe platform itself. The dedicated WS handler
// (handleBreatheSalesWsConnection) runs the sales tool set: identify the
// call reason, email platform info, capture a lead, or start a sign-up.
//
// PHI posture: there is no patient PHI in scope here — this is a software
// sales call. The caller's number is logged only as a digit count.

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  buildConnectStreamTwiml,
  buildHangupTwiml,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { getPendingSessions } from "../../lib/voice/pending-sessions";
import {
  publicWsOriginFromBaseUrl,
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoicePublicBaseUrls,
} from "../../lib/voice/voice-config";

const BREATHE_SALES_GREETING =
  "Hi, thanks for calling CareMetric Breathe! I can walk you through the " +
  "platform, talk through pricing, or help you get set up — what brings you " +
  "in today?";

const BREATHE_SALES_CALL_CONTEXT =
  "Inbound sales call to the CareMetric Breathe platform line. The caller is " +
  "a prospective DME business. Identify why they called, then pitch, help, or " +
  "take a message accordingly.";

const router: IRouter = Router();

const inboundBody = z.object({
  From: z.string().trim().optional(),
  CallSid: z.string().trim().min(1),
  Caller: z.string().trim().optional(),
  To: z.string().trim().optional(),
  Called: z.string().trim().optional(),
});

const signatureMiddleware = requireTwilioSignature({
  // Token-only reader so the webhook authenticates even when OPENAI_API_KEY
  // is unset; reconstruct the public URL independently so the signature
  // comparison matches (same posture as inbound-reorder).
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  // The platform sales line is reachable on the platform host (cmbreathe.com)
  // as well as whatever host the tenant lines use, so validate the Twilio
  // signature against the configured allowlist of voice hosts rather than a
  // single global host. Each candidate still requires a valid HMAC.
  buildPublicUrl: (req) => {
    const originalUrl = req.originalUrl ?? "";
    return readVoicePublicBaseUrls().map((base) => `${base}${originalUrl}`);
  },
});

/** Compare two phone numbers tolerantly (exact, else digits-only). */
function sameNumber(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const digits = (s: string): string => s.replace(/\D+/g, "");
  const da = digits(a);
  const db = digits(b);
  return da.length > 0 && da === db;
}

router.post(
  "/voice/inbound-breathe-sales",
  signatureMiddleware,
  async (req, res) => {
    const config = readVoiceConfigOrNull();
    if (!config) {
      res
        .status(503)
        .type("text/xml")
        .send(buildHangupTwiml("Voice service unavailable."));
      return;
    }
    const parsed = inboundBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .type("text/xml")
        .send(buildHangupTwiml("Invalid call payload."));
      return;
    }
    const { From, CallSid } = parsed.data;
    const calledNumber = parsed.data.Called ?? parsed.data.To ?? "";

    // Guard: this route only serves the configured platform sales number.
    // Defensive — Twilio should only ever target this route for that number,
    // but a misconfigured webhook must never run the sales persona on some
    // other line. Unset number → the line isn't live → clean hangup.
    const salesNumber = (process.env.BREATHE_SALES_VOICE_NUMBER ?? "").trim();
    if (!salesNumber || !sameNumber(calledNumber, salesNumber)) {
      logger.info(
        {
          event: "voice.inbound-breathe-sales.wrong_number",
          callSid: CallSid,
          configured: salesNumber.length > 0,
        },
        "voice.inbound-breathe-sales: called number is not the sales line; hanging up",
      );
      res
        .status(200)
        .type("text/xml")
        .send(buildHangupTwiml("This line is not available."));
      return;
    }

    // Feature-flag gate (platform-scoped → seed org; no orgId arg).
    if (!(await isFeatureEnabled("voice.breathe_sales"))) {
      logger.info(
        { event: "voice.inbound-breathe-sales.disabled", callSid: CallSid },
        "voice.inbound-breathe-sales: sales agent disabled; hanging up",
      );
      res
        .status(200)
        .type("text/xml")
        .send(
          buildHangupTwiml(
            "Thanks for calling CareMetric Breathe. Our line isn't taking calls right now — please try again later.",
          ),
        );
      return;
    }

    // Register a pending session. NO orgId (platform-scoped), NO patient/
    // episode/customer, NO conversations row — the registry key is a fresh
    // UUID the WS upgrade claims. The sales WS handler runs the agent.
    const conversationId = randomUUID();
    getPendingSessions().register({
      conversationId,
      patientId: "",
      episodeId: "",
      twilioCallSid: CallSid,
      callerKind: "breathe_prospect",
      callContext: BREATHE_SALES_CALL_CONTEXT,
      greeting: BREATHE_SALES_GREETING,
      // The caller dialed US — the agent greets first rather than waiting for
      // the caller to break the silence.
      agentSpeaksFirst: true,
    });

    const wsUrl =
      `${publicWsOriginFromBaseUrl(config.publicBaseUrl)}` +
      `/resupply-api/voice/stream?conversationId=${encodeURIComponent(conversationId)}`;
    logger.info(
      {
        event: "voice.inbound-breathe-sales.connected",
        callSid: CallSid,
        // PHI-free: digit count only, never the caller's number.
        fromDigits: (From ?? parsed.data.Caller ?? "").replace(/\D+/g, "")
          .length,
      },
      "voice.inbound-breathe-sales: connecting caller to the platform sales agent",
    );
    res
      .status(200)
      .type("text/xml")
      .send(
        buildConnectStreamTwiml({
          wsUrl,
          customParameters: { conversationId },
        }),
      );
  },
);

export default router;
