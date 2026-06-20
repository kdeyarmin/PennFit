// POST /voice/place-call — admin-initiated outbound call.
//
// Flow:
//   1. requireAdmin gate (in-house pf_session cookie + role check).
//   2. Voice config gate — 503 if any required env var is missing.
//   3. Body validation (zod) — { patientId, episodeId } UUIDs.
//   4. Delegate the actual placement to the shared
//      `placeOutboundReorderCall` helper (validate patient + episode,
//      open the voice conversation, register the pending session, dial
//      Twilio, stamp the CallSid, audit). The SAME helper backs the
//      automated `reminders.place-call` escalation job, so the admin
//      "Call" button and the cron walk an identical code path.
//   5. Map the helper's tagged outcome onto the HTTP status the SPA
//      expects.
//
// What happens on failure (unchanged from the historical inline impl):
//   - Patient/episode not found → 404. No row created.
//   - Patient has no phone → 422 (operationally distinct: nothing's
//     "broken", we just can't call them).
//   - Twilio API error → 502. The conversations row IS created so the
//     dashboard sees the failed-attempt audit trail (the helper does not
//     roll it back — the audit log + the dashboard timeline both need to
//     show "the admin tried to call at T").

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logger } from "../../lib/logger";
import { placeOutboundReorderCall } from "../../lib/voice/place-outbound-call";
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const outcome = await placeOutboundReorderCall({
      orgId,
      patientId,
      episodeId,
      config: { ...config, twilioPhoneNumber: config.twilioPhoneNumber },
      actor: {
        kind: "admin",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
    });

    switch (outcome.status) {
      case "patient_not_found":
        res.status(404).json({ error: "patient_not_found" });
        return;
      case "patient_not_active":
        res.status(409).json({
          error: "patient_not_active",
          message: `Patient status is "${outcome.patientStatus}"; only active patients can be called.`,
        });
        return;
      case "patient_missing_phone":
        res.status(422).json({
          error: "patient_missing_phone",
          message: "Patient row has no phone number on file.",
        });
        return;
      case "episode_not_found":
        res.status(404).json({ error: "episode_not_found" });
        return;
      case "episode_patient_mismatch":
        res.status(422).json({
          error: "episode_patient_mismatch",
          message: "Episode does not belong to the supplied patient.",
        });
        return;
      case "conversation_create_failed":
        res.status(500).json({ error: "conversation_create_failed" });
        return;
      case "twilio_config_error":
        res.status(503).json({ error: "twilio_config_error" });
        return;
      case "twilio_api_error":
        res.status(502).json({
          error: "twilio_api_error",
          twilioStatus: outcome.twilioStatus,
          twilioCode: outcome.twilioCode,
        });
        return;
      case "ok":
        res.status(201).json({
          conversationId: outcome.conversationId,
          callSid: outcome.callSid,
        });
        return;
      default: {
        // Exhaustiveness guard — a new outcome variant must add a case.
        const _never: never = outcome;
        logger.error(
          { outcome: _never },
          "voice.place-call: unhandled placement outcome",
        );
        res.status(500).json({ error: "internal_error" });
        return;
      }
    }
  },
);

export default router;
