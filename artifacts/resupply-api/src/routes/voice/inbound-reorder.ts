// POST /voice/inbound-reorder
//
// AI-powered inbound reorder IVR. Twilio routes inbound calls to a
// dedicated "Reorder Line" number to this endpoint. We:
//
//   1. Look up the caller by their `From` phone number against
//      shop_customers + patients.
//   2. Create a voice_reorder_sessions row (in_progress).
//   3. Return TwiML that opens a Media Stream to the existing
//      OpenAI Realtime bridge, scoped to the identified patient.
//
// When the caller cannot be identified (unknown number, blocked CID),
// we still create a session in 'patient_not_identified' state and
// hand them off to a human via <Dial> to the support number.
//
// The session is closed by the bridge / status-callback handler when
// the call ends.
//
// PHI posture: the From number IS PHI (it can re-identify the patient).
// We log only digit-prefix counts; full numbers stay in the
// voice_reorder_sessions row, which is RLS-scoped via the existing
// resupply schema policies.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import {
  buildConnectStreamTwiml,
  buildHangupTwiml,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { getPendingSessions } from "../../lib/voice/pending-sessions";
import { resolveCallerByPhone } from "../../lib/voice/resolve-caller";
import {
  publicWsOriginFromBaseUrl,
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

// Episode statuses a caller can still act on by phone (pre-confirm). A
// confirmed/fulfilled/cancelled episode has nothing left to reorder, so
// we don't route those to the agent.
const ACTIONABLE_EPISODE_STATUSES = [
  "outreach_pending",
  "awaiting_response",
  "declined",
] as const;

const INBOUND_CALL_CONTEXT =
  "Inbound call: the patient phoned our CPAP resupply line to reorder. " +
  "Verify identity by date of birth, review what's due, confirm the " +
  "address on file, then place the order.";

const INBOUND_GREETING =
  "Hi there, thanks for calling your CPAP resupply line! I can help you " +
  "reorder your supplies today.";

const INBOUND_SHOP_CALL_CONTEXT =
  "Inbound call: a storefront customer phoned to check on their account. " +
  "Verify by the last four digits of the card on file, then review their " +
  "recent order and subscription status. For any change, hand off to a human.";

const INBOUND_SHOP_GREETING =
  "Hi there, thanks for calling PennPaps! I can help you check on your " +
  "account today.";

// Human fallback number, shared by the unidentified and no-actionable-
// episode paths.
const SUPPORT_DIAL_E164 = "+18144710627";

const router: IRouter = Router();

const inboundBody = z.object({
  From: z.string().trim().optional(),
  CallSid: z.string().trim().min(1),
  Caller: z.string().trim().optional(),
});

const signatureMiddleware = requireTwilioSignature({
  // Use token-only reader so inbound webhooks authenticate even when
  // OPENAI_API_KEY is unset. The public base URL also must be
  // sourced independently of the full voice config — otherwise the
  // signature comparison reconstructs the URL with an empty base and
  // 403s on every signed inbound.
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post("/voice/inbound-reorder", signatureMiddleware, async (req, res) => {
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
  const supabase = getSupabaseServiceRoleClient();

  // 1. Identify the caller. A DB failure here must NOT be silently treated
  // as "unidentified" — that would mask an outage and mis-route the caller.
  // Surface it and ask the caller to retry (same posture as the session-
  // insert failure below); log only the digit-count to keep PHI out.
  const callerE164 = From ?? parsed.data.Caller ?? "";
  let patientId: string | null;
  let shopCustomerId: string | null;
  let ambiguous: boolean;
  try {
    ({ patientId, shopCustomerId, ambiguous } = await identifyCaller(
      supabase,
      callerE164,
    ));
  } catch (err) {
    logger.warn(
      {
        event: "voice.inbound-reorder.identify_failed",
        callSid: CallSid,
        fromDigits: callerE164.replace(/\D+/g, "").length,
        err,
      },
      "voice.inbound-reorder: caller identification failed",
    );
    res
      .status(500)
      .type("text/xml")
      .send(
        buildHangupTwiml(
          "We're having trouble taking your call. Please try again in a few minutes.",
        ),
      );
    return;
  }

  // 2. Persist session row.
  const sessionStatus = patientId ? "in_progress" : "patient_not_identified";
  const { data: session, error } = await supabase
    .schema("resupply")
    .from("voice_reorder_sessions")
    .insert({
      twilio_call_sid: CallSid,
      from_e164: callerE164.slice(0, 20),
      patient_id: patientId,
      shop_customer_id: shopCustomerId,
      status: sessionStatus,
    })
    .select("id")
    .single();
  if (error) {
    logger.warn(
      { err: error.message, callSid: CallSid },
      "voice.inbound-reorder: session insert failed",
    );
    res
      .status(500)
      .type("text/xml")
      .send(
        buildHangupTwiml(
          "We're having trouble taking your call. Please try again in a few minutes.",
        ),
      );
    return;
  }

  // Transfer the caller to a human (used by both the storefront and patient
  // flows on any fall-through). Records the outcome on the session first.
  const transferToHuman = async (reason: string): Promise<void> => {
    const { error: transferStampErr } = await supabase
      .schema("resupply")
      .from("voice_reorder_sessions")
      .update({
        status: "transferred_to_human",
        outcome_json: { routed: "human", reason } as unknown as Json,
      })
      .eq("id", session.id);
    if (transferStampErr) {
      logger.warn(
        { err: transferStampErr.message, sessionId: session.id },
        "voice.inbound-reorder: transfer outcome stamp failed (caller still transferred)",
      );
    }
    res
      .status(200)
      .type("text/xml")
      .send(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<Response>",
          "<Say>Hi! Welcome to your PennPaps reorder line. ",
          "Connecting you to our team now.</Say>",
          `<Dial timeout="20">${SUPPORT_DIAL_E164}</Dial>`,
          "</Response>",
        ].join(""),
      );
  };

  // 2b. Matched storefront (cash-pay) caller → connect to the storefront
  // voice agent: verify by card last-4, read account status, hand off for
  // any change. Same Connect/Stream machinery as the patient flow, but the
  // conversation is bound to the shop customer (customer_id) and the agent
  // runs in "shop_customer" mode. Falls back to a human on any hiccup.
  if (!patientId && shopCustomerId && !ambiguous) {
    if (!(await isFeatureEnabled("voice.agent"))) {
      logger.info(
        { event: "voice.inbound-reorder.agent_disabled", callSid: CallSid },
        "voice.inbound-reorder: voice agent disabled; transferring shop caller",
      );
      await transferToHuman("voice_agent_disabled");
      return;
    }
    let shopConversationId: string;
    try {
      const { data: conv, error: convErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .insert({
          customer_id: shopCustomerId,
          // patient_id / episode_id stay null — the conversations subject-
          // XOR check requires customer_id rows to have both null.
          patient_id: null,
          episode_id: null,
          channel: "voice",
          status: "open",
          external_ref: CallSid,
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (convErr) throw convErr;
      shopConversationId = conv.id;
    } catch (err) {
      logger.warn(
        {
          err,
          callSid: CallSid,
        },
        "voice.inbound-reorder: shop conversation create failed; transferring",
      );
      await transferToHuman("shop_conversation_create_failed");
      return;
    }

    getPendingSessions().register({
      conversationId: shopConversationId,
      // Patient/episode are empty for a storefront caller; callerKind +
      // shopCustomerId drive the shop tool set + prompt.
      patientId: "",
      episodeId: "",
      callerKind: "shop_customer",
      shopCustomerId,
      callContext: INBOUND_SHOP_CALL_CONTEXT,
      greeting: INBOUND_SHOP_GREETING,
      // The caller dialed US — the agent must greet first, not wait for
      // the caller to break the silence.
      agentSpeaksFirst: true,
    });

    // Best-effort metadata stamp — the TwiML response (and the call) must go
    // out regardless, so log a warning on failure rather than throwing.
    const { error: shopStampErr } = await supabase
      .schema("resupply")
      .from("voice_reorder_sessions")
      .update({
        // The row was inserted as patient_not_identified (no patient), but a
        // matched storefront caller IS being actively handled — mark it
        // in_progress so ops/analytics don't misclassify the call.
        status: "in_progress",
        outcome_json: {
          routed: "realtime_bridge",
          conversation_id: shopConversationId,
          caller_kind: "shop_customer",
        } as unknown as Json,
      })
      .eq("id", session.id);
    if (shopStampErr) {
      logger.warn(
        { err: shopStampErr.message, sessionId: session.id },
        "inbound-reorder: failed to stamp shop session in_progress",
      );
    }

    const shopWsUrl =
      `${publicWsOriginFromBaseUrl(config.publicBaseUrl)}` +
      `/resupply-api/voice/stream?conversationId=${encodeURIComponent(shopConversationId)}`;
    logger.info(
      {
        event: "voice.inbound-reorder.connected",
        callSid: CallSid,
        sessionId: session.id,
        callerKind: "shop_customer",
      },
      "voice.inbound-reorder: connecting storefront caller to the realtime agent",
    );
    res
      .status(200)
      .type("text/xml")
      .send(
        buildConnectStreamTwiml({
          wsUrl: shopWsUrl,
          customParameters: { conversationId: shopConversationId },
        }),
      );
    return;
  }

  // 3a. Unknown (or ambiguous) caller → transfer to human. An ambiguous
  // match (one phone, multiple patients) is deliberately treated as
  // unidentified so we never bind the AI reorder agent to an arbitrary
  // patient's episode.
  if (!patientId) {
    logger.info(
      {
        event: ambiguous
          ? "voice.inbound-reorder.ambiguous_phone"
          : "voice.inbound-reorder.unidentified",
        callSid: CallSid,
        // Log only the digit-count to keep PHI out of logs.
        fromDigits: callerE164.replace(/\D+/g, "").length,
      },
      ambiguous
        ? "voice.inbound-reorder: caller number on multiple accounts, transferring"
        : "voice.inbound-reorder: caller not identified, transferring",
    );
    res
      .status(200)
      .type("text/xml")
      .send(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<Response>",
          "<Say>We couldn't match your phone number to an existing account.",
          "Connecting you to our team now.</Say>",
          '<Dial timeout="20">+18144710627</Dial>',
          "</Response>",
        ].join(""),
      );
    return;
  }

  // 3b. Identified caller → connect to the AI reorder agent (the
  // existing OpenAI Realtime bridge) when (a) the voice agent is enabled
  // in the Control Center AND (b) the patient has an episode they can
  // still act on. We reuse the proven outbound machinery: create a voice
  // `conversations` row bound to the episode (exactly like place-call),
  // register a pending session, and return the same Connect/Stream TwiML
  // that points Twilio's Media Stream at /resupply-api/voice/stream —
  // the unchanged WS upgrade handler then claims it and runs the bridge.
  // Anything else falls back to a human, which is strictly better than
  // greeting the caller and dropping them.
  if (!(await isFeatureEnabled("voice.agent"))) {
    logger.info(
      { event: "voice.inbound-reorder.agent_disabled", callSid: CallSid },
      "voice.inbound-reorder: voice agent disabled; transferring to human",
    );
    await transferToHuman("voice_agent_disabled");
    return;
  }

  const episodeId = await findActionableEpisodeId(supabase, patientId);
  if (!episodeId) {
    logger.info(
      {
        event: "voice.inbound-reorder.no_actionable_episode",
        callSid: CallSid,
        sessionId: session.id,
      },
      "voice.inbound-reorder: no actionable episode; transferring to human",
    );
    await transferToHuman("no_actionable_episode");
    return;
  }

  // Bind a voice conversation to the episode (mirrors place-call).
  let conversationId: string;
  try {
    const { data: conv, error: convErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .insert({
        patient_id: patientId,
        episode_id: episodeId,
        channel: "voice",
        status: "open",
        external_ref: CallSid,
        last_message_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (convErr) throw convErr;
    conversationId = conv.id;
  } catch (err) {
    logger.warn(
      {
        err,
        callSid: CallSid,
      },
      "voice.inbound-reorder: conversation create failed; transferring to human",
    );
    await transferToHuman("conversation_create_failed");
    return;
  }

  // Register the pending session BEFORE returning TwiML so the WS
  // upgrade (which races the TwiML response) finds it. Inbound-flavored
  // callContext + greeting so the agent doesn't tell a caller who dialed
  // in that we're calling them.
  getPendingSessions().register({
    conversationId,
    patientId,
    episodeId,
    callContext: INBOUND_CALL_CONTEXT,
    greeting: INBOUND_GREETING,
    // The caller dialed US — the agent must greet first, not wait for
    // the caller to break the silence.
    agentSpeaksFirst: true,
  });

  // Best-effort metadata stamp — the TwiML response must go out regardless.
  const { error: patientStampErr } = await supabase
    .schema("resupply")
    .from("voice_reorder_sessions")
    .update({
      outcome_json: {
        routed: "realtime_bridge",
        conversation_id: conversationId,
        episode_id: episodeId,
      } as unknown as Json,
    })
    .eq("id", session.id);
  if (patientStampErr) {
    logger.warn(
      { err: patientStampErr.message, sessionId: session.id },
      "inbound-reorder: failed to stamp patient session outcome",
    );
  }

  const wsUrl =
    `${publicWsOriginFromBaseUrl(config.publicBaseUrl)}` +
    `/resupply-api/voice/stream?conversationId=${encodeURIComponent(conversationId)}`;
  logger.info(
    {
      event: "voice.inbound-reorder.connected",
      callSid: CallSid,
      sessionId: session.id,
    },
    "voice.inbound-reorder: connecting caller to the realtime reorder agent",
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

/**
 * Most recent episode the caller can still act on by phone (a pre-confirm
 * status). Returns null on no match or any lookup error → the route then
 * transfers the caller to a human rather than opening an agent session
 * with nothing to reorder.
 */
async function findActionableEpisodeId(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  patientId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("episodes")
    .select("id, status, created_at")
    .eq("patient_id", patientId)
    .in("status", [...ACTIONABLE_EPISODE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message },
      "voice.inbound-reorder: episode lookup failed",
    );
    return null;
  }
  return data?.id ?? null;
}

interface IdentifyResult {
  patientId: string | null;
  shopCustomerId: string | null;
  /** True when more than one patient shares this caller-ID number. */
  ambiguous: boolean;
}

async function identifyCaller(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  fromE164: string,
): Promise<IdentifyResult> {
  // Unified resolution across clinical patients + cash-pay storefront
  // customers (patients win on a tie). The shared-number / ambiguity
  // rules live in resolveCallerByPhone; we map its discriminated result
  // back onto the IdentifyResult shape the rest of this route expects.
  const resolution = await resolveCallerByPhone(supabase, fromE164);
  switch (resolution.kind) {
    case "patient":
      return {
        patientId: resolution.patientId,
        shopCustomerId: null,
        ambiguous: false,
      };
    case "shop_customer":
      return {
        patientId: null,
        shopCustomerId: resolution.customerId,
        ambiguous: false,
      };
    case "ambiguous":
      return { patientId: null, shopCustomerId: null, ambiguous: true };
    case "none":
      return { patientId: null, shopCustomerId: null, ambiguous: false };
  }
}

export default router;
