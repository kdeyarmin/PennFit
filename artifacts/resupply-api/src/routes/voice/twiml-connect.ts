// POST /voice/twiml-connect — Twilio call-answered webhook.
//
// Twilio invokes this URL after the patient answers the outbound call.
// Our job is to return TwiML that tells Twilio "open a Media Stream
// WS to my bridge endpoint and connect this call to it".
//
// Excluded from the public OpenAPI spec on purpose: this endpoint is
// for Twilio only. It carries no admin-facing contract; documenting
// it would just make it a more obvious target for unsigned probes.
//
// Why we PEEK and not CLAIM:
//   The pending-session entry has to survive past this webhook —
//   Twilio's WS upgrade arrives a moment later, and the upgrade
//   handler is the one that consumes the entry. If we claimed here,
//   the upgrade would always fail.

import { Router, type IRouter } from "express";

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
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

const router: IRouter = Router();

const signatureMiddleware = requireTwilioSignature({
  // Read the token at request time so secret rotation does not require
  // a process restart. Use the token-only reader (not the full voice
  // config) so signature validation works on inbound webhooks even
  // when OPENAI_API_KEY is unset — outbound voice may be offline but
  // inbound TwiML and status callbacks should still authenticate.
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  // Reconstruct the URL Twilio originally signed: the public base URL
  // (e.g. https://<railway-public-domain>) + the path Twilio POSTed
  // to. We intentionally use `originalUrl` (path + query) because
  // Twilio's signature includes the FULL URL with the query string.
  buildPublicUrl: (req) => {
    // Decoupled from the full voice config so signature verification
    // still works in token-only mode (OPENAI_API_KEY unset).
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    // express request: typed as SignatureRequestLike here, but the real
    // request also carries originalUrl. Cast through unknown to read it.
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post("/voice/twiml-connect", signatureMiddleware, async (req, res) => {
  const config = readVoiceConfigOrNull();
  if (!config) {
    // Reachable now that signature verification is decoupled from
    // the full voice config (readTwilioWebhookAuthTokenOrNull +
    // readVoicePublicBaseUrlOrNull): inbound webhooks can
    // authenticate even when OPENAI_API_KEY is unset (e.g. the
    // realtime voice path is offline). Return 200 with hangup TwiML
    // matching the feature-flag-off branch below so Twilio sees a
    // clean disposition and does NOT retry on its exponential
    // backoff. 503 here would trigger the retry storm.
    res
      .status(200)
      .type("text/xml")
      .send(buildHangupTwiml("This service is temporarily unavailable. Please try again later."));
    return;
  }

  // Control Center feature gate. When the voice agent is turned off
  // we hang the caller up cleanly rather than route them to the AI
  // bridge. The hangup TwiML returns 200 so Twilio doesn't retry.
  if (!(await isFeatureEnabled("voice.agent"))) {
    logger.info(
      { event: "voice_twiml_disabled_by_feature_flag" },
      "twiml-connect: voice agent disabled via Control Center; hanging up",
    );
    res
      .status(200)
      .type("text/xml")
      .send(
        buildHangupTwiml(
          "Sorry, our automated assistant is unavailable right now. Please call back during business hours.",
        ),
      );
    return;
  }

  const conversationId =
    typeof req.query.conversationId === "string"
      ? req.query.conversationId
      : null;

  if (!conversationId) {
    logger.warn(
      { event: "voice_twiml_missing_conversation_id" },
      "twiml-connect missing conversationId",
    );
    res.status(400).type("text/xml").send(buildHangupTwiml("Missing call id."));
    return;
  }

  // Peek (NOT claim) — see file header.
  const pending = getPendingSessions().peek(conversationId);
  if (!pending) {
    logger.warn(
      {
        event: "voice_twiml_no_pending_session",
        conversationId,
      },
      "twiml-connect: no pending session — TTL'd or never registered",
    );
    res
      .status(404)
      .type("text/xml")
      .send(
        buildHangupTwiml(
          "Sorry, this call could not be connected. Please try again later.",
        ),
      );
    return;
  }

  const wsOrigin = publicWsOriginFromBaseUrl(config.publicBaseUrl);
  const wsUrl = `${wsOrigin}/resupply-api/voice/stream?conversationId=${encodeURIComponent(
    conversationId,
  )}`;

  const twiml = buildConnectStreamTwiml({
    wsUrl,
    customParameters: {
      // Echoed back inside the Twilio `start` frame. The WS handler
      // uses URL-query parsing as its primary binding; this is a
      // belt-and-braces secondary channel for debugging / future
      // multi-instance routing.
      conversationId,
    },
  });

  res.status(200).type("text/xml").send(twiml);
});

export default router;
