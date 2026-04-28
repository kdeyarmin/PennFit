// POST /sms/send-reminder — operator-initiated outbound SMS.
//
// Thin wrapper around `sendReminderSms` from @workspace/resupply-reminders.
// Both the API route and the worker's reminders.send-sms job call the
// same helper — the helper owns conversation creation, phone_lookup
// upsert, Twilio invocation, message-row persistence, and audit
// emission. This route's job is just:
//   1. requireOperator gate.
//   2. Messaging-config readiness gate (503 with stable error code).
//   3. Body validation (zod).
//   4. Delegate to sendReminderSms.
//   5. Translate the helper's tagged outcome to an HTTP response.
//
// We do NOT roll back the conversations row when Twilio rejects the
// send: the operator made the attempt, the audit log + dashboard
// timeline must show that. This matches the voice place-call
// philosophy.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";
import {
  sendReminderSms,
  type SendReminderOutcome,
} from "@workspace/resupply-reminders";
import { TwilioConfigError } from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { readMessagingConfigOrNull } from "../../lib/messaging/messaging-config";
import { requireOperator } from "../../middlewares/requireOperator";

const sendBody = z
  .object({
    patientId: z.string().uuid(),
    episodeId: z.string().uuid().optional(),
    /**
     * Optional override for the message body. When absent the helper
     * renders a default reminder template. Operator-typed bodies are
     * passed through verbatim (encrypted at rest in `messages.body`).
     */
    body: z.string().min(1).max(1600).optional(),
  })
  .strict();

const router: IRouter = Router();

router.post("/sms/send-reminder", requireOperator, async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res.status(503).json({
      error: "messaging_not_configured",
      message:
        "SMS+Email reminders are disabled because one or more required env " +
        "vars are missing. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
        "TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID, SENDGRID_API_KEY, " +
        "SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME, " +
        "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, RESUPPLY_PHONE_HMAC_KEY, " +
        "RESUPPLY_LINK_HMAC_KEY.",
    });
    return;
  }

  const parsed = sendBody.safeParse(req.body);
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
  const { patientId, episodeId, body } = parsed.data;

  let outcome: SendReminderOutcome;
  try {
    outcome = await sendReminderSms({
      pool: getDbPool(),
      cfg: {
        twilioAccountSid: cfg.sms.twilioAccountSid,
        twilioAuthToken: cfg.sms.twilioAuthToken,
        twilioPhoneNumber: cfg.sms.twilioPhoneNumber,
        twilioMessagingServiceSid: cfg.sms.twilioMessagingServiceSid,
        publicBaseUrl: cfg.sms.publicBaseUrl,
        practiceName: cfg.practiceName,
      },
      patientId,
      episodeId,
      body,
      actor: {
        kind: "operator",
        operatorEmail: req.operatorEmail ?? null,
        operatorClerkId: req.operatorClerkId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
    });
  } catch (err) {
    if (err instanceof TwilioConfigError) {
      logger.error(
        { err: { name: err.name, message: err.message } },
        "sms.send-reminder: twilio config error",
      );
      res.status(503).json({ error: "twilio_config_error" });
      return;
    }
    throw err;
  }

  switch (outcome.status) {
    case "ok":
      res.status(201).json({
        conversationId: outcome.conversationId,
        messageSid: outcome.vendorRef,
      });
      return;
    case "patient_not_found":
      res.status(404).json({ error: "patient_not_found" });
      return;
    case "patient_not_active":
      res.status(409).json({
        error: "patient_not_active",
        message: `Patient status is "${outcome.patientStatus}".`,
      });
      return;
    case "patient_missing_phone":
      res.status(422).json({
        error: "patient_missing_phone",
        message: "Patient row has no phone number on file.",
      });
      return;
    case "patient_phone_unnormalizable":
      res.status(422).json({
        error: "patient_phone_unnormalizable",
        message: "Patient phone is not a valid E.164 number.",
      });
      return;
    case "phone_in_use_by_other_patient":
      // The patient shares a phone number with a different patient
      // already in the system. We refused to overwrite the lookup row
      // because doing so would silently re-route inbound STOP/HELP
      // and order-confirmation replies onto the wrong patient. The
      // operator must resolve the duplicate before any reminder can
      // be sent. We deliberately do NOT include the conflicting
      // patient_id in the response body — operators look it up via
      // the audit row (`messaging.phone_lookup.conflict`) where
      // access is gated by their existing roles.
      res.status(409).json({
        error: "phone_in_use_by_other_patient",
        message:
          "This phone number is already bound to another patient. Resolve the duplicate before sending reminders.",
      });
      return;
    case "no_episode_for_patient":
      res.status(404).json({ error: "no_episode_for_patient" });
      return;
    case "episode_not_found":
      res.status(404).json({ error: "episode_not_found" });
      return;
    case "episode_patient_mismatch":
      res.status(422).json({ error: "episode_patient_mismatch" });
      return;
    case "conversation_create_failed":
      res.status(500).json({ error: "conversation_create_failed" });
      return;
    case "vendor_api_error":
      res.status(502).json({
        error: "twilio_api_error",
        twilioStatus: outcome.vendorStatus,
        twilioCode: outcome.vendorCode,
      });
      return;
    case "patient_missing_email":
    case "vendor_config_error":
      // These outcomes are not produced by the SMS helper — exhaustive
      // switch guard for type safety.
      res.status(500).json({ error: "unexpected_outcome" });
      return;
  }
});

export default router;
