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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";
import {
  buildHangupTwiml,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import {
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

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

  // 1. Identify the caller (best-effort).
  const callerE164 = From ?? parsed.data.Caller ?? "";
  const { patientId, shopCustomerId } = await identifyCaller(
    supabase,
    callerE164,
  );

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

  // 3a. Unknown caller → transfer to human.
  if (!patientId) {
    logger.info(
      {
        event: "voice.inbound-reorder.unidentified",
        callSid: CallSid,
        // Log only the digit-count to keep PHI out of logs.
        fromDigits: callerE164.replace(/\D+/g, "").length,
      },
      "voice.inbound-reorder: caller not identified, transferring",
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

  // 3b. Identified caller. The Realtime reorder bridge is not yet
  // wired (the WS upgrade handler in index.ts only accepts the
  // /resupply-api/voice/stream path with a pending-session
  // conversationId; the reorder shape uses voice_reorder_sessions.id
  // and there is no WS handler that consumes it yet). Until the
  // bridge ships, transfer the identified caller to the human team
  // — that's strictly better than greeting them and then dropping
  // the call when the WS handshake fails.
  //
  // Once the reorder WS handler lands, swap this back to a Connect
  // / Stream TwiML pointing at /resupply-api/voice/stream with the
  // reorderSessionId param (and register the session via
  // getPendingSessions() so the upgrade handler can claim it).
  logger.info(
    {
      event: "voice.inbound-reorder.identified",
      callSid: CallSid,
      sessionId: session.id,
    },
    "voice.inbound-reorder: caller identified, transferring (reorder bridge not yet wired)",
  );
  res
    .status(200)
    .type("text/xml")
    .send(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        "<Say>Hi! Welcome to your PennPaps reorder line. ",
        "Connecting you to our team now.</Say>",
        '<Dial timeout="20">+18144710627</Dial>',
        "</Response>",
      ].join(""),
    );
});

interface IdentifyResult {
  patientId: string | null;
  shopCustomerId: string | null;
}

async function identifyCaller(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  fromE164: string,
): Promise<IdentifyResult> {
  if (!fromE164) return { patientId: null, shopCustomerId: null };
  // Use the canonical E.164 normalizer (same as the SMS + inbound voice
  // paths) so a bare 10-digit US caller ID maps to +1XXXXXXXXXX and
  // matches the stored patients.phone_e164. The previous naive
  // `+${digits}` produced `+2155551212` (no country code) and silently
  // failed to identify a known caller. null ⇒ unparseable ⇒ unidentified.
  const normalised = normalizeE164(fromE164);
  if (!normalised) return { patientId: null, shopCustomerId: null };
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("phone_e164", normalised)
    .limit(1)
    .maybeSingle();
  return {
    patientId: patient?.id ?? null,
    // shop_customers doesn't carry phone_e164 today; we leave the
    // hookup for when the storefront captures it (storefront opt-in
    // SMS flow).
    shopCustomerId: null,
  };
}

export default router;
