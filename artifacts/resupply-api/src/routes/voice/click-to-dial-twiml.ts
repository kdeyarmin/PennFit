// POST /voice/click-to-dial-twiml — the bridge leg of CSR #11.
//
// Twilio fetches this when the CALLING AGENT answers their phone (the
// agent-first leg placed by /admin/patients/:id/click-to-dial). It looks
// up the disposition → patient phone and returns TwiML that <Dial>s the
// patient, bridging the two legs. The patient's number lives only in
// this server→Twilio response — it never reaches the browser.
//
// Twilio-signature gated (the same posture as the AI-agent webhooks).
// Any miss (bad/no disposition, patient gone, no phone) returns a clean
// 200 Hangup so Twilio doesn't retry-storm.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  buildDialTwiml,
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

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    const originalUrl = req.originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post(
  "/voice/click-to-dial-twiml",
  signatureMiddleware,
  async (req, res) => {
    const sendHangup = (msg: string) =>
      res.status(200).type("text/xml").send(buildHangupTwiml(msg));

    const dispositionId = String(
      (req.query as { dispositionId?: unknown }).dispositionId ?? "",
    ).trim();
    if (dispositionId === "") {
      sendHangup("Missing call reference. Please try again.");
      return;
    }

    const config = readVoiceConfigOrNull();
    const callerId = config?.twilioPhoneNumber;

    const supabase = getSupabaseServiceRoleClient();
    const dispRes = await supabase
      .schema("resupply")
      .from("call_dispositions")
      .select("id, patient_id")
      .eq("id", dispositionId)
      .maybeSingle();
    const patientId = (dispRes.data as { patient_id?: string | null } | null)
      ?.patient_id;
    if (dispRes.error || !patientId) {
      logger.warn(
        {
          event: "click_to_dial_twiml.disposition_miss",
          disposition_id: dispositionId,
        },
        "click-to-dial-twiml: disposition/patient not found",
      );
      sendHangup("We couldn't connect this call. Please try again.");
      return;
    }

    const patientRes = await supabase
      .schema("resupply")
      .from("patients")
      .select("phone_e164")
      .eq("id", patientId)
      .maybeSingle();
    const phone = (patientRes.data as { phone_e164?: string | null } | null)
      ?.phone_e164;
    if (patientRes.error || !phone) {
      sendHangup("The patient has no number on file.");
      return;
    }

    let twiml: string;
    try {
      twiml = buildDialTwiml({
        to: phone,
        callerId: callerId ?? undefined,
        timeLimitSeconds: 600,
        spokenMessage: "Connecting you to the patient now.",
      });
    } catch {
      // Non-E.164 number on file — fail cleanly rather than 5xx-loop.
      sendHangup("The patient's number is invalid.");
      return;
    }

    res.status(200).type("text/xml").send(twiml);
  },
);

export default router;
