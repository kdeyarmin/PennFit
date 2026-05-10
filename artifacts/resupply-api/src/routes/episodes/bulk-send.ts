// POST /episodes/bulk-send — fan-out a reminder dispatch over a
// dispatcher-selected slate of episodes.
//
// Each input episodeId is processed independently against the same
// helper used by /sms/send-reminder and /email/send-reminder so the
// row-level outcome (audit trail, conversation creation, vendor
// dispatch) is bit-for-bit identical to the single-send path. We
// look up the patient_id for each episode in a single round-trip,
// then iterate the helpers serially to avoid hammering Twilio /
// SendGrid concurrency limits — a 50-id bulk send completes well
// under the dashboard's mutation timeout even at 1 req/sec.
//
// Partial failure is the EXPECTED outcome; a 200 response with
// per-id results is correct even when zero items succeeded. The
// dashboard reads `summary` for the "23 sent / 4 skipped / 3 failed"
// toast and walks `results[]` for row-level reasons.
//
// We do NOT roll back any row that succeeded if a later row fails
// (analogous to the single-send path). Each row's audit trail and
// conversation persist independently — that's the property the
// dispatcher relies on to "see what actually went out."

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  sendReminderSms,
  sendReminderEmail,
  type SendReminderOutcome,
} from "@workspace/resupply-reminders";
import { TwilioConfigError } from "@workspace/resupply-telecom";
import { EmailConfigError } from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { readMessagingConfigOrNull } from "../../lib/messaging/messaging-config";
import { requireAdmin } from "../../middlewares/requireAdmin";

const MAX_IDS = 50;

// Each bulk call may trigger up to 50 vendor sends. Cap per-admin to 10
// calls/hour (500 messages max), matching the prescription-renewals limiter.
const bulkSendLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.adminUserId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests", limiter: "episodes_bulk_send" },
});

const bulkBody = z
  .object({
    episodeIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_IDS)
      // De-duplicate while preserving input order so the response
      // results[] order matches what the dispatcher selected.
      .transform((ids) => Array.from(new Set(ids))),
    channel: z.enum(["sms", "email"]),
  })
  .strict();

interface ItemResult {
  episodeId: string;
  status: "ok" | "error";
  conversationId?: string | null;
  vendorRef?: string | null;
  error?: string | null;
  message?: string | null;
}

const router: IRouter = Router();

router.post("/episodes/bulk-send", requireAdmin, bulkSendLimiter, async (req, res) => {
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

  const parsed = bulkBody.safeParse(req.body);
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
  const { episodeIds, channel } = parsed.data;

  // Single round-trip lookup of (id → patient_id). Episodes whose
  // ids don't appear in the result will be reported as
  // `episode_not_found` per-id below — the bulk endpoint deliberately
  // does NOT 404 the whole request just because one id was bogus.
  const supabase = getSupabaseServiceRoleClient();
  const { data: lookupRows, error: lookupErr } = await supabase
    .schema("resupply")
    .from("episodes")
    .select("id, patient_id")
    .in("id", episodeIds);
  if (lookupErr) throw lookupErr;
  const patientByEpisode = new Map<string, string>();
  for (const row of lookupRows ?? []) {
    patientByEpisode.set(row.id, row.patient_id);
  }

  const actor = {
    kind: "admin" as const,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };

  const results: ItemResult[] = [];

  for (const episodeId of episodeIds) {
    const patientId = patientByEpisode.get(episodeId);
    if (!patientId) {
      results.push({
        episodeId,
        status: "error",
        error: "episode_not_found",
        message: "No episode row matched this id.",
      });
      continue;
    }

    let outcome: SendReminderOutcome;
    try {
      if (channel === "sms") {
        outcome = await sendReminderSms({
          supabase,
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
          actor,
        });
      } else {
        outcome = await sendReminderEmail({
          supabase,
          cfg: {
            sendgridApiKey: cfg.email.sendgridApiKey,
            sendgridFromEmail: cfg.email.sendgridFromEmail,
            sendgridFromName: cfg.email.sendgridFromName,
            publicBaseUrl: cfg.email.publicBaseUrl,
            practiceName: cfg.practiceName,
          },
          patientId,
          episodeId,
          actor,
        });
      }
    } catch (err) {
      // Vendor config errors are NOT going to suddenly start working
      // mid-batch, so we abort the rest of the queue and return what
      // we have. Mark every remaining episode as `vendor_config_error`
      // so the dispatcher can re-queue them after the env var fix.
      if (err instanceof TwilioConfigError || err instanceof EmailConfigError) {
        const code =
          err instanceof TwilioConfigError
            ? "twilio_config_error"
            : "sendgrid_config_error";
        logger.error(
          { err: { name: err.name, message: err.message } },
          `episodes.bulk-send: ${code} — aborting remaining ids`,
        );
        results.push({
          episodeId,
          status: "error",
          error: code,
          message: "Vendor configuration error. Remaining items skipped.",
        });
        const seen = new Set(results.map((r) => r.episodeId));
        for (const remaining of episodeIds) {
          if (!seen.has(remaining)) {
            results.push({
              episodeId: remaining,
              status: "error",
              error: code,
              message: "Skipped due to vendor configuration error.",
            });
          }
        }
        break;
      }
      // Genuinely unexpected — bubble to the global error handler.
      throw err;
    }

    if (outcome.status === "ok") {
      results.push({
        episodeId,
        status: "ok",
        conversationId: outcome.conversationId,
        vendorRef: outcome.vendorRef,
      });
      continue;
    }

    // Translate the helper's tagged outcome into the bulk response's
    // stable error vocabulary (mirrors single-send's MessagingError).
    const error = outcome.status;
    const message = errorMessageFor(outcome);
    results.push({
      episodeId,
      status: "error",
      error,
      message,
    });
  }

  const sent = results.filter((r) => r.status === "ok").length;
  const failed = results.length - sent;

  res.status(200).json({
    summary: {
      total: results.length,
      sent,
      failed,
    },
    results,
  });
});

function errorMessageFor(outcome: SendReminderOutcome): string {
  switch (outcome.status) {
    case "patient_not_found":
      return "Patient row not found for this episode.";
    case "patient_not_active":
      return `Patient status is "${outcome.patientStatus}".`;
    case "patient_missing_phone":
      return "Patient row has no phone number on file.";
    case "patient_missing_email":
      return "Patient row has no email address on file.";
    case "patient_phone_unnormalizable":
      return "Patient phone is not a valid E.164 number.";
    case "phone_in_use_by_other_patient":
      return "Phone number is bound to another patient. Resolve the duplicate first.";
    case "no_episode_for_patient":
      return "Patient has no eligible episode for this reminder.";
    case "episode_not_found":
      return "Episode row not found.";
    case "episode_patient_mismatch":
      return "Episode does not belong to its expected patient.";
    case "conversation_create_failed":
      return "Internal error — conversation row could not be created.";
    case "vendor_api_error":
      return "Vendor rejected the send.";
    case "vendor_config_error":
      return "Vendor configuration is invalid.";
    case "ok":
      return "";
  }
}

export default router;
