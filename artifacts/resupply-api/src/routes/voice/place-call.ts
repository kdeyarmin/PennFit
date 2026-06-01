// POST /voice/place-call — admin-initiated outbound call.
//
// Flow:
//   1. requireAdmin gate (in-house pf_session cookie + role check).
//   2. Voice config gate — 503 if any required env var is missing.
//   3. Body validation (zod) — { patientId, episodeId } UUIDs.
//   4. Patient + episode lookup. Read phone number directly; refuse
//      if the patient row carries no phone or the episode doesn't
//      belong to the patient.
//   5. Insert a `conversations` row (channel='voice', status='open').
//   6. Register a pending-session entry keyed on conversationId.
//   7. Place the Twilio call. Twilio webhook URL embeds conversationId.
//   8. Stamp the returned CallSid onto the pending-session entry +
//      audit `voice.call.placed`.
//   9. Respond { conversationId, callSid }.
//
// What happens on failure:
//   - Patient/episode not found → 404. No row created.
//   - Patient has no phone → 422 (operationally distinct: nothing's
//     "broken", we just can't call them).
//   - Twilio API error → 502. The conversations row IS created so the
//     dashboard sees the failed-attempt audit trail; the
//     pending-session entry will TTL out on its own.
//
// We deliberately do NOT roll back the conversations row on Twilio
// failure: the audit log + the dashboard timeline both need to show
// "the admin tried to call at T". Rolling back would erase that
// trail — exactly the wrong instinct for an admin-action audit.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createTwilioClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { getPendingSessions } from "../../lib/voice/pending-sessions";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const placeCallBody = z
  .object({
    patientId: z.string().uuid(),
    episodeId: z.string().uuid(),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/voice/place-call",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const config = readVoiceConfigOrNull();
    if (!config) {
      res.status(503).json({
        error: "voice_not_configured",
        message:
          "Voice routes are disabled because one or more required env " +
          "vars are missing (OPENAI_API_KEY, TWILIO_ACCOUNT_SID, " +
          "TWILIO_AUTH_TOKEN, RESUPPLY_VOICE_PUBLIC_BASE_URL).",
      });
      return;
    }
    if (!config.twilioPhoneNumber) {
      res.status(503).json({
        error: "voice_outbound_not_configured",
        message:
          "TWILIO_PHONE_NUMBER is not set — outbound calls cannot be placed.",
      });
      return;
    }

    const parsed = placeCallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { patientId, episodeId } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Patient existence + phone + status. PostgREST has no JOIN, so
    // the patient and episode reads stay separate but can run in
    // parallel.
    const [patientRes, episodeRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("id, phone_e164, status")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("episodes")
        .select("id, patient_id")
        .eq("id", episodeId)
        .limit(1)
        .maybeSingle(),
    ]);
    if (patientRes.error) throw patientRes.error;
    if (episodeRes.error) throw episodeRes.error;
    const patient = patientRes.data;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (patient.status !== "active") {
      res.status(409).json({
        error: "patient_not_active",
        message: `Patient status is "${patient.status}"; only active patients can be called.`,
      });
      return;
    }
    if (!patient.phone_e164) {
      res.status(422).json({
        error: "patient_missing_phone",
        message: "Patient row has no phone number on file.",
      });
      return;
    }

    const episode = episodeRes.data;
    if (!episode) {
      res.status(404).json({ error: "episode_not_found" });
      return;
    }
    if (episode.patient_id !== patientId) {
      res.status(422).json({
        error: "episode_patient_mismatch",
        message: "Episode does not belong to the supplied patient.",
      });
      return;
    }

    // Create the conversation row up front so the dashboard timeline
    // shows the attempt even if Twilio rejects the dial.
    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .insert({
        patient_id: patientId,
        episode_id: episodeId,
        channel: "voice",
        status: "open",
        last_message_at: new Date().toISOString(),
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    const conversationId = inserted?.id;
    if (!conversationId) {
      res.status(500).json({ error: "conversation_create_failed" });
      return;
    }

    // Register pending session BEFORE Twilio dials so the WS upgrade —
    // which can race the API response — sees the entry the moment
    // Twilio's servers connect their socket back.
    getPendingSessions().register({
      conversationId,
      patientId,
      episodeId,
    });

    const baseUrl = config.publicBaseUrl;
    const twimlUrl = `${baseUrl}/resupply-api/voice/twiml-connect?conversationId=${encodeURIComponent(
      conversationId,
    )}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/voice/status-callback?conversationId=${encodeURIComponent(
      conversationId,
    )}`;

    let callSid: string;
    try {
      const twilio = createTwilioClient({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
      });
      const result = await twilio.placeCall({
        to: patient.phone_e164,
        from: config.twilioPhoneNumber,
        url: twimlUrl,
        statusCallbackUrl,
      });
      callSid = result.sid;
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        logger.error(
          { err: { name: err.name, message: err.message } },
          "voice.place-call: twilio config error",
        );
        res.status(503).json({ error: "twilio_config_error" });
        return;
      }
      if (err instanceof TwilioApiError) {
        // Audit the failed attempt — admin did initiate the call,
        // even if Twilio refused. PHI-safe: phone number is NOT in
        // metadata, only the structural failure code.
        await safeAudit({
          action: "voice.call.placed",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "conversations",
          targetId: conversationId,
          metadata: {
            patient_id: patientId,
            episode_id: episodeId,
            conversation_id: conversationId,
            status: "twilio_error",
            twilio_status: err.status ?? null,
            twilio_code: err.code ?? null,
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
        res.status(502).json({
          error: "twilio_api_error",
          twilioStatus: err.status,
          twilioCode: err.code,
        });
        return;
      }
      throw err;
    }

    getPendingSessions().attachCallSid(conversationId, callSid);
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        external_ref: callSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    if (updateErr) throw updateErr;

    await safeAudit({
      action: "voice.call.placed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: {
        patient_id: patientId,
        episode_id: episodeId,
        conversation_id: conversationId,
        status: "ok",
        twilio_call_sid: callSid,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    res.status(201).json({ conversationId, callSid });
  },
);

// Audit failures must NOT 500 a successful (or already-failed)
// place-call response. We log them and move on — there's a separate
// alert path for "audit writes are silently failing".
async function safeAudit(event: Parameters<typeof logAudit>[0]): Promise<void> {
  try {
    await logAudit(event);
  } catch (err) {
    logger.error(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      "voice.place-call: logAudit failed",
    );
  }
}

export default router;
