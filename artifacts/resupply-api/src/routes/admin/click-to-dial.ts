// CSR #11 — click-to-dial + post-call disposition.
//
//   POST /admin/patients/:patientId/click-to-dial
//     Agent-first Twilio bridge: Twilio rings the CALLING AGENT's own
//     phone (admin_users.phone_e164) first; when they answer, the
//     signed /voice/click-to-dial-twiml webhook bridges the patient in.
//     The patient's number never reaches the browser. A call_dispositions
//     row is created in 'initiated' the moment the dial is placed.
//
//   POST /admin/call-dispositions/:id
//     The CSR logs the outcome (reached / voicemail / …) + an optional
//     note after hanging up.
//
// Guardrail (ground rule 8): outbound calls respect a TCPA-style call
// window (9am–7pm ET, Mon–Sat). Outside it the dial is refused unless
// the CSR passes `override: true` (e.g. the patient asked us to call
// now) — the override is recorded on the disposition.
//
// PHI posture: phone numbers and the disposition note are NEVER logged.
// The app logger sees ids + outcome + structural codes only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createTwilioClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export const CALL_OUTCOMES = [
  "reached",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "wrong_number",
  "callback_requested",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * Pure: TCPA-style call window — 9am–7pm in the given zone, Monday
 * through Saturday (Sunday excluded; quiet-hours rules are stricter).
 * Mirrors the dispatcher's voice window; kept local + exported so it's
 * unit-tested without importing the dispatcher module.
 */
export function withinCallWindow(
  now: Date,
  timeZone = "America/New_York",
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  if (weekday === "Sun") return false;
  return hour >= 9 && hour < 19;
}

const patientIdParam = z.string().uuid();
const dialBody = z
  .object({ override: z.boolean().optional() })
  .strict()
  .optional();

router.post(
  "/admin/patients/:patientId/click-to-dial",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParsed = patientIdParam.safeParse(req.params.patientId);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const bodyParsed = dialBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const patientId = idParsed.data;
    const override = bodyParsed.data?.override ?? false;

    const config = readVoiceConfigOrNull();
    if (!config || !config.twilioPhoneNumber) {
      res.status(503).json({
        error: "voice_outbound_not_configured",
        message:
          "Outbound calling needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
          "TWILIO_PHONE_NUMBER, and RESUPPLY_VOICE_PUBLIC_BASE_URL.",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    const patientRes = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, phone_e164, status")
      .eq("id", patientId)
      .maybeSingle();
    if (patientRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: patientRes.error.message });
      return;
    }
    const patient = patientRes.data as {
      phone_e164?: string | null;
      status?: string | null;
    } | null;
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
      res.status(422).json({ error: "patient_missing_phone" });
      return;
    }

    // Call-window guardrail (overridable, recorded).
    if (!withinCallWindow(new Date()) && !override) {
      res.status(409).json({
        error: "outside_call_window",
        message:
          "Outside the 9am–7pm ET call window (Mon–Sat). Resend with override to call anyway.",
      });
      return;
    }

    // The agent's own bridge number — Twilio dials THIS first.
    const agentRes = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("phone_e164")
      .eq("id", req.adminUserId ?? "")
      .maybeSingle();
    if (agentRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: agentRes.error.message });
      return;
    }
    const agentPhone = (agentRes.data as { phone_e164?: string | null } | null)
      ?.phone_e164;
    if (!agentPhone) {
      res.status(422).json({
        error: "agent_phone_missing",
        message:
          "Set your callback number before placing calls (admin_users.phone_e164).",
      });
      return;
    }

    // Create the disposition up front so an abandoned/failed dial still
    // leaves a trail.
    const insertRes = await supabase
      .schema("resupply")
      .from("call_dispositions")
      .insert({
        patient_id: patientId,
        outcome: "initiated",
        agent_user_id: req.adminUserId ?? null,
        agent_email: req.adminEmail ?? null,
        note: override ? "[call-window override]" : null,
      })
      .select("id")
      .maybeSingle();
    if (insertRes.error || !insertRes.data) {
      res.status(500).json({ error: "disposition_create_failed" });
      return;
    }
    const dispositionId = (insertRes.data as { id: string }).id;

    const twimlUrl = `${config.publicBaseUrl}/resupply-api/voice/click-to-dial-twiml?dispositionId=${encodeURIComponent(
      dispositionId,
    )}`;

    let callSid: string;
    try {
      const twilio = createTwilioClient({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
      });
      const result = await twilio.placeCall({
        to: agentPhone,
        from: config.twilioPhoneNumber,
        url: twimlUrl,
      });
      callSid = result.sid;
    } catch (err) {
      await supabase
        .schema("resupply")
        .from("call_dispositions")
        .update({ outcome: "failed", updated_at: new Date().toISOString() })
        .eq("id", dispositionId);
      if (err instanceof TwilioConfigError) {
        res.status(503).json({ error: "twilio_config_error" });
        return;
      }
      if (err instanceof TwilioApiError) {
        logger.warn(
          {
            event: "admin.click_to_dial.twilio_error",
            patient_id: patientId,
            disposition_id: dispositionId,
            twilio_status: err.status ?? null,
            twilio_code: err.code ?? null,
          },
          "click-to-dial: twilio api error",
        );
        res.status(502).json({
          error: "twilio_api_error",
          dispositionId,
          twilioStatus: err.status,
          twilioCode: err.code,
        });
        return;
      }
      throw err;
    }

    await supabase
      .schema("resupply")
      .from("call_dispositions")
      .update({
        twilio_call_sid: callSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", dispositionId);

    logger.info(
      {
        event: "admin.click_to_dial.placed",
        patient_id: patientId,
        disposition_id: dispositionId,
        override,
        adminEmail: req.adminEmail,
      },
      "admin.click_to_dial.placed",
    );

    res.status(201).json({ dispositionId, callSid });
  },
);

// Patient call history — the recent dispositions for the patient panel.
router.get(
  "/admin/patients/:patientId/call-dispositions",
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParsed = patientIdParam.safeParse(req.params.patientId);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("call_dispositions")
      .select("id, outcome, note, agent_email, created_at")
      .eq("patient_id", idParsed.data)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      outcome: String(r.outcome),
      // The note is the CSR's tool; returned to them but never logged.
      note: r.note == null ? null : String(r.note),
      agentEmail: r.agent_email == null ? null : String(r.agent_email),
      createdAt: String(r.created_at),
    }));
    res.json({ dispositions: rows, count: rows.length });
  },
);

const dispositionIdParam = z.string().uuid();
const logDispositionBody = z
  .object({
    outcome: z.enum(CALL_OUTCOMES),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();

router.post(
  "/admin/call-dispositions/:id",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParsed = dispositionIdParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_disposition_id" });
      return;
    }
    const bodyParsed = logDispositionBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { outcome, note } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const updateRes = await supabase
      .schema("resupply")
      .from("call_dispositions")
      .update({
        outcome,
        note: note ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", idParsed.data)
      .select("id, outcome")
      .maybeSingle();
    if (updateRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: updateRes.error.message });
      return;
    }
    if (!updateRes.data) {
      res.status(404).json({ error: "disposition_not_found" });
      return;
    }

    // Outcome only — never the note (PHI).
    logger.info(
      {
        event: "admin.call_disposition.logged",
        disposition_id: idParsed.data,
        outcome,
        adminEmail: req.adminEmail,
      },
      "admin.call_disposition.logged",
    );

    res.json({ id: idParsed.data, outcome });
  },
);

export default router;
