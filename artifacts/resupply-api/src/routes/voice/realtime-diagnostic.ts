// POST /voice/realtime-diagnostic
//
// A no-patient "connection test" for the AI voice agent. Dial a Twilio
// number pointed here and the OpenAI Realtime bridge opens in a DIAGNOSTIC
// mode — no patient lookup, no DB writes, no tools — so an operator can
// validate the live voice path end to end (audio in/out, transcription,
// turn-taking, barge-in) WITHOUT setting up a patient record. This is how
// you re-test the gpt-realtime-2 GA spike: set OPENAI_REALTIME_SCHEMA=ga,
// dial in, and listen. See docs/runbooks/realtime-ga-migration.md.
//
// Gated TWO ways, because a Realtime session costs money and we never want
// an open faucet:
//   1. Twilio HMAC signature (same as every inbound voice webhook).
//   2. OPENAI_REALTIME_DIAGNOSTIC_ENABLED must be truthy. Off by default —
//      intended for previews, not production. When off, we answer with a
//      polite hangup so a misconfigured number can't open a session.
//
// PHI posture: a diagnostic call has no patient and writes nothing. The
// caller's number is not looked up or stored. The agent prompt explicitly
// tells it not to collect any personal information.

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  buildConnectStreamTwiml,
  buildHangupTwiml,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { getPendingSessions } from "../../lib/voice/pending-sessions";
import {
  publicWsOriginFromBaseUrl,
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

const DIAGNOSTIC_CALL_CONTEXT =
  "CONNECTION TEST — this is an automated voice diagnostic, not a real " +
  "patient call. There is no account to look up and no tools are available. " +
  "Greet the caller warmly, make brief natural conversation to confirm " +
  "two-way audio is working, and answer anything they ask conversationally. " +
  "Do NOT ask for identity, date of birth, or any personal information. " +
  "If the caller says goodbye, end the call.";

const DIAGNOSTIC_GREETING =
  "Hi there — this is a quick voice connection test. Can you hear me okay? " +
  "Say a few words back so we can check the audio.";

const router: IRouter = Router();

const diagnosticBody = z.object({
  CallSid: z.string().trim().min(1),
});

const signatureMiddleware = requireTwilioSignature({
  // Token-only reader + independent public-base-URL source, identical to the
  // other inbound voice webhooks (see inbound-reorder.ts for the rationale).
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post("/voice/realtime-diagnostic", signatureMiddleware, (req, res) => {
  const config = readVoiceConfigOrNull();
  if (!config) {
    res
      .status(503)
      .type("text/xml")
      .send(buildHangupTwiml("Voice service unavailable."));
    return;
  }
  // The faucet must be explicitly opened. Off → polite hangup.
  if (!config.realtimeDiagnosticEnabled) {
    logger.info(
      { event: "voice.realtime-diagnostic.disabled" },
      "voice.realtime-diagnostic: disabled (OPENAI_REALTIME_DIAGNOSTIC_ENABLED not set)",
    );
    res
      .status(200)
      .type("text/xml")
      .send(
        buildHangupTwiml(
          "The voice diagnostic is not enabled on this environment. Goodbye.",
        ),
      );
    return;
  }
  const parsed = diagnosticBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .type("text/xml")
      .send(buildHangupTwiml("Invalid call payload."));
    return;
  }

  // No patient, no DB row — a random conversationId is the only handle the
  // WS upgrade needs. `diagnostic: true` routes it to the isolated bridge.
  const conversationId = randomUUID();
  getPendingSessions().register({
    conversationId,
    patientId: "",
    episodeId: "",
    callContext: DIAGNOSTIC_CALL_CONTEXT,
    greeting: DIAGNOSTIC_GREETING,
    diagnostic: true,
    // The operator dialed in — greet immediately, same as the inbound
    // production flows (this also makes the diagnostic exercise the
    // agent-speaks-first path before it ships).
    agentSpeaksFirst: true,
  });

  const wsUrl =
    `${publicWsOriginFromBaseUrl(config.publicBaseUrl)}` +
    `/resupply-api/voice/stream?conversationId=${encodeURIComponent(conversationId)}`;
  logger.info(
    {
      event: "voice.realtime-diagnostic.connected",
      callSid: parsed.data.CallSid,
      schema: config.realtimeSchema,
    },
    "voice.realtime-diagnostic: opening diagnostic Realtime bridge",
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
});

export default router;
