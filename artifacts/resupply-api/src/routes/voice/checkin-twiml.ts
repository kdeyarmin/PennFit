// /voice/checkin-twiml + /voice/checkin-press — TwiML webhook +
// DTMF callback for the automated onboarding check-in calls placed
// by the multi-channel dispatcher.
//
// Flow:
//   1. Dispatcher → Twilio.placeCall({ url: /voice/checkin-twiml?day=...&patientId=...&journeyId=... })
//   2. Patient answers → Twilio POSTs /voice/checkin-twiml.
//   3. We render <Say> + <Gather numDigits="1" action="/voice/checkin-press?patientId=...&journeyId=...&day=...">.
//   4. If the patient presses 1, Twilio POSTs /voice/checkin-press
//      with `Digits=1`. We create a `manual` csr_compliance_alert
//      attributing the alert to that patient + journey + day.
//   5. If the patient hangs up (no input), <Gather> times out,
//      <Say> says goodbye, <Hangup>. No alert.
//
// Why this is much cheaper than /voice/twiml-connect:
//   The other voice path bridges a Media Stream WS to an OpenAI
//   realtime model — useful for genuine conversation but ~$0.30/min.
//   This path uses Twilio's built-in <Say> + <Gather>, which is
//   ~$0.013/min (Twilio call cost only) and handles the 95% case
//   ("patient just wants to acknowledge").
//
// Twilio signature is verified — these endpoints are public, and
// without verification anyone with the URL could spam alert rows.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { voiceScriptForDay } from "../../lib/checkin-dispatcher";
import { logger } from "../../lib/logger";
import {
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";
import type { OnboardingDayLabel } from "@workspace/resupply-db";

const router: IRouter = Router();

const signatureMiddleware = requireTwilioSignature({
  // Read Twilio token + public base URL independently of the full
  // voice config — inbound webhooks must authenticate even when
  // OPENAI_API_KEY is unset (inbound-only deployment, transient
  // outage). Without this, every signed Twilio webhook 403s with
  // signature_mismatch because cfg?.publicBaseUrl resolves to "".
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    const base = readVoicePublicBaseUrlOrNull() ?? "";
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
    const cfg = readVoiceConfigOrNull();
    const dayRaw = (req.query["day"] ?? "").toString();
    const day = (VALID_DAYS as readonly string[]).includes(dayRaw)
      ? (dayRaw as OnboardingDayLabel)
      : "day7";
    const script = voiceScriptForDay(day);
    const patientId = (req.query["patientId"] ?? "").toString();
    const journeyId = (req.query["journeyId"] ?? "").toString();

    // The press-1 callback URL embeds the same identifiers so we don't
    // have to rely on Twilio re-sending them. Dropping back through
    // the dispatcher's call URL would also work but pinning them in
    // the action URL is more robust against Twilio dropping query
    // parameters on the callback POST.
    const base = cfg?.publicBaseUrl ?? "";
    const pressActionUrl =
      `${base}/resupply-api/voice/checkin-press?` +
      [
        `patientId=${encodeURIComponent(patientId)}`,
        `journeyId=${encodeURIComponent(journeyId)}`,
        `day=${encodeURIComponent(day)}`,
      ].join("&");

    res
      .status(200)
      .type("application/xml")
      .send(
        [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<Response>`,
          `  <Say voice="Polly.Joanna">${escapeXmlText(script)}</Say>`,
          `  <Pause length="1"/>`,
          `  <Gather numDigits="1" action="${escapeXmlAttr(pressActionUrl)}" method="POST" timeout="6">`,
          `    <Say voice="Polly.Joanna">If you would like a member of our team to call you back, press 1 now. Otherwise just hang up.</Say>`,
          `  </Gather>`,
          // <Gather> falls through here on timeout — no input, hang up.
          `  <Say voice="Polly.Joanna">Thanks for using Penn Paps. Goodbye.</Say>`,
          `  <Hangup/>`,
          `</Response>`,
        ].join("\n"),
      );
  },
);

const pressBody = z
  .object({
    Digits: z.string().optional(),
    CallSid: z.string().optional(),
    From: z.string().optional(),
  })
  .passthrough();

router.post(
  "/voice/checkin-press",
  signatureMiddleware,
  async (req: Request, res) => {
    const parsed = pressBody.safeParse(req.body ?? {});
    const digits = parsed.success ? (parsed.data.Digits ?? "") : "";
    const patientIdRaw = (req.query["patientId"] ?? "").toString();
    const journeyIdRaw = (req.query["journeyId"] ?? "").toString();
    const dayRaw = (req.query["day"] ?? "").toString();
    const patientIdParsed = z.string().uuid().safeParse(patientIdRaw);

    // Anything other than "1" means the patient hung up or fat-
    // fingered something. Don't manufacture an alert from noise.
    if (digits !== "1" || !patientIdParsed.success) {
      res
        .status(200)
        .type("application/xml")
        .send(
          [
            `<?xml version="1.0" encoding="UTF-8"?>`,
            `<Response>`,
            `  <Say voice="Polly.Joanna">Thanks. Goodbye.</Say>`,
            `  <Hangup/>`,
            `</Response>`,
          ].join("\n"),
        );
      return;
    }

    const patientId = patientIdParsed.data;
    const journeyId = z.string().uuid().safeParse(journeyIdRaw).success
      ? journeyIdRaw
      : null;
    const day = (VALID_DAYS as readonly string[]).includes(dayRaw)
      ? dayRaw
      : null;

    const supabase = getSupabaseServiceRoleClient();

    // Belt-and-braces: confirm the patient exists before we insert.
    // A malicious caller who somehow forged a Twilio signature still
    // can't use this endpoint to create alerts for arbitrary UUIDs.
    const { data: existsRow, error: existsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (existsErr) {
      logger.error(
        { err: existsErr, patient_id: patientId },
        "voice.checkin_press: patient lookup failed",
      );
      // Fall through with hangup — surfacing a 5xx to Twilio would
      // queue retries and re-prompt the caller, which is worse for
      // the customer than silently giving up on the alert.
    }
    if (!existsRow) {
      logger.warn(
        { patient_id: patientId },
        "voice.checkin_press: unknown patient",
      );
      res
        .status(200)
        .type("application/xml")
        .send(
          [
            `<?xml version="1.0" encoding="UTF-8"?>`,
            `<Response><Say voice="Polly.Joanna">Thanks. Goodbye.</Say><Hangup/></Response>`,
          ].join("\n"),
        );
      return;
    }

    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        journey_id: journeyId,
        alert_type: "manual",
        severity: "warning",
        summary: day
          ? `Patient pressed 1 during ${day} automated check-in call — wants a callback`
          : "Patient pressed 1 during automated check-in call — wants a callback",
        metric_snapshot: {
          triggered_by: "voice_checkin_press",
          day_label: day,
          call_sid: parsed.success ? (parsed.data.CallSid ?? null) : null,
        },
      });
    if (insertErr) {
      // 23505 → an open manual alert already exists for this patient.
      // That's fine — the existing alert is the right thing to act on.
      const code = (insertErr as { code?: string }).code;
      if (code !== "23505") {
        logger.error(
          { err: insertErr, patient_id: patientId },
          "voice.checkin_press: alert insert failed",
        );
      }
    }

    await logAudit({
      action: "voice.checkin_press",
      adminEmail: null,
      adminUserId: null,
      targetTable: "csr_compliance_alerts",
      targetId: null,
      metadata: {
        patient_id: patientId,
        journey_id: journeyId,
        day_label: day,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "voice.checkin_press audit write failed");
    });

    res
      .status(200)
      .type("application/xml")
      .send(
        [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<Response>`,
          `  <Say voice="Polly.Joanna">Thank you. A member of our team will call you back during business hours. Goodbye.</Say>`,
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

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default router;
