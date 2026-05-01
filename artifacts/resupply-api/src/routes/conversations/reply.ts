// POST /conversations/:id/reply — admin-typed reply appended to an
// existing conversation thread (SMS or email).
//
// Distinct from POST /sms/send-reminder and POST /email/send-reminder:
// those endpoints START a new conversation row each time (correct for
// templated reminders); this endpoint APPENDS to the conversation the
// admin is already viewing. The channel is taken from the
// `conversations` row, not from the request body — admins reply on
// whichever channel the patient was already using.
//
// Voice conversations are intentionally unsupported: there is no
// admin-typed reply path on a phone call. The helper returns a
// `patient_missing_contact` outcome and we surface 409 here so the
// dashboard can hide the composer for voice threads.
//
// PHI in audit log: never. The helper records `body_length` so admins
// can spot suspiciously empty/long replies, but the message body
// itself only lives in `messages.body`.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";
import {
  replyInConversation,
  type ReplyInConversationOutcome,
} from "@workspace/resupply-reminders";
import { TwilioConfigError } from "@workspace/resupply-telecom";
import { EmailConfigError } from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { readMessagingConfigOrNull } from "../../lib/messaging/messaging-config";
import { withIdempotency } from "../../middlewares/idempotency";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const bodySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Reply body cannot be empty.")
      .max(1600, "Reply body must be 1600 characters or fewer."),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/conversations/:id/reply",
  requireAdmin,
  withIdempotency("POST /conversations/:id/reply"),
  async (req, res) => {
  const idParsed = idParam.safeParse(req.params);
  if (!idParsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res.status(503).json({
      error: "messaging_not_configured",
      message:
        "SMS+Email reply is disabled because one or more required env " +
        "vars are missing. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
        "TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID, SENDGRID_API_KEY, " +
        "SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME, " +
        "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, and RESUPPLY_LINK_HMAC_KEY.",
    });
    return;
  }

  const bodyParsed = bodySchema.safeParse(req.body);
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

  const { id: conversationId } = idParsed.data;
  const { body } = bodyParsed.data;

  let outcome: ReplyInConversationOutcome;
  try {
    outcome = await replyInConversation({
      pool: getDbPool(),
      smsCfg: { ...cfg.sms, practiceName: cfg.practiceName },
      emailCfg: { ...cfg.email, practiceName: cfg.practiceName },
      conversationId,
      body,
      actor: {
        kind: "admin",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
    });
  } catch (err) {
    if (err instanceof TwilioConfigError || err instanceof EmailConfigError) {
      logger.error(
        { err, conversation_id: conversationId },
        "POST /conversations/:id/reply: vendor config error",
      );
      res.status(503).json({
        error: "vendor_config_error",
        message: err.message,
      });
      return;
    }
    throw err;
  }

  switch (outcome.status) {
    case "ok":
      res.status(201).json({
        messageId: outcome.messageId,
        conversationId: outcome.conversationId,
        vendorRef: outcome.vendorRef,
      });
      return;
    case "conversation_not_found":
      res.status(404).json({ error: "not_found" });
      return;
    case "conversation_closed":
      res.status(409).json({
        error: "conversation_closed",
        message: "This conversation is closed. Start a new one with the patient.",
      });
      return;
    case "patient_missing_contact":
      res.status(409).json({
        error: "patient_missing_contact",
        channel: outcome.channel,
        message:
          outcome.channel === "sms"
            ? "Patient has no phone number on file (or the conversation is on a voice channel — voice replies are not supported)."
            : "Patient has no email address on file.",
      });
      return;
    case "patient_phone_unnormalizable":
      res.status(422).json({
        error: "patient_phone_unnormalizable",
        message: "Patient's phone number couldn't be parsed as E.164.",
      });
      return;
    case "vendor_api_error":
      logger.warn(
        {
          conversation_id: conversationId,
          vendor: outcome.vendor,
          vendor_status: outcome.vendorStatus,
          vendor_code: outcome.vendorCode,
        },
        "POST /conversations/:id/reply: vendor api error",
      );
      res.status(502).json({
        error: "vendor_api_error",
        vendor: outcome.vendor,
        vendorStatus: outcome.vendorStatus,
        vendorCode: outcome.vendorCode,
        message: "The SMS/email vendor rejected the message. The attempt is in the audit log.",
      });
      return;
  }
});

export default router;
