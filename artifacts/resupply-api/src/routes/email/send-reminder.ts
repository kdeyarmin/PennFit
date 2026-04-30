// POST /email/send-reminder — admin-initiated outbound email.
//
// Thin wrapper around `sendReminderEmail` from @workspace/resupply-reminders.
// Both the API route and the worker's reminders.send-email job call the
// same helper — the helper owns conversation creation, link-token
// signing, template rendering, SendGrid invocation, message-row
// persistence, and audit emission.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";
import { EmailConfigError } from "@workspace/resupply-email";
import {
  sendReminderEmail,
  type SendReminderOutcome,
} from "@workspace/resupply-reminders";

import { logger } from "../../lib/logger";
import { readMessagingConfigOrNull } from "../../lib/messaging/messaging-config";
import { requireAdmin } from "../../middlewares/requireAdmin";

const sendBody = z
  .object({
    patientId: z.string().uuid(),
    episodeId: z.string().uuid().optional(),
  })
  .strict();

const router: IRouter = Router();

router.post("/email/send-reminder", requireAdmin, async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res.status(503).json({
      error: "messaging_not_configured",
      message:
        "SMS+Email reminders are disabled because one or more required env " +
        "vars are missing.",
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
  const { patientId, episodeId } = parsed.data;

  let outcome: SendReminderOutcome;
  try {
    outcome = await sendReminderEmail({
      pool: getDbPool(),
      cfg: {
        sendgridApiKey: cfg.email.sendgridApiKey,
        sendgridFromEmail: cfg.email.sendgridFromEmail,
        sendgridFromName: cfg.email.sendgridFromName,
        publicBaseUrl: cfg.email.publicBaseUrl,
        practiceName: cfg.practiceName,
      },
      patientId,
      episodeId,
      actor: {
        kind: "admin",
        adminEmail: req.adminEmail ?? null,
        adminClerkId: req.adminClerkId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
    });
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.error(
        { err: { name: err.name, message: err.message } },
        "email.send-reminder: sendgrid config error",
      );
      res.status(503).json({ error: "sendgrid_config_error" });
      return;
    }
    throw err;
  }

  switch (outcome.status) {
    case "ok":
      res.status(201).json({
        conversationId: outcome.conversationId,
        messageId: outcome.vendorRef,
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
    case "patient_missing_email":
      res.status(422).json({
        error: "patient_missing_email",
        message: "Patient row has no email address on file.",
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
        error: "sendgrid_api_error",
        sendgridStatus: outcome.vendorStatus,
      });
      return;
    case "patient_missing_phone":
    case "patient_phone_unnormalizable":
    case "vendor_config_error":
      // These outcomes are not produced by the email helper — exhaustive
      // switch guard for type safety.
      res.status(500).json({ error: "unexpected_outcome" });
      return;
  }
});

export default router;
