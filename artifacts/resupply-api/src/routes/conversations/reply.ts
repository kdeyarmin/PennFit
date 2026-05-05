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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  conversations,
  DEFAULT_COMMUNICATION_PREFERENCES,
  getDbPool,
  shopCustomers,
  type CommunicationPreferences,
} from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";
import {
  replyInConversation,
  type ReplyInConversationOutcome,
} from "@workspace/resupply-reminders";
import { TwilioConfigError } from "@workspace/resupply-telecom";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import {
  appendAdminInAppReply,
  IN_APP_MESSAGE_BODY_MAX,
} from "../../lib/messaging/in-app-conversation";
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
      // Cap at the larger of the two channel limits — SMS replies
      // get clamped further by the dispatcher (1600 chars to stay
      // under Twilio's hard limit). In-app threads tolerate the
      // wider 4000-char cap from IN_APP_MESSAGE_BODY_MAX.
      .max(
        IN_APP_MESSAGE_BODY_MAX,
        `Reply body must be ${IN_APP_MESSAGE_BODY_MAX} characters or fewer.`,
      ),
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

    // Branch by channel BEFORE we read the messaging-config envvars.
    // In-app threads don't need Twilio/SendGrid to be configured for
    // the message itself to land — the message is just a DB row. We
    // do try to send a notification email afterwards (best-effort),
    // but a missing SENDGRID_API_KEY is not fatal for in-app — the
    // customer will see the message next time they sign in.
    const earlyDb = drizzle(getDbPool());
    const channelRows = await earlyDb
      .select({ channel: conversations.channel })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const channelRow = channelRows[0];
    if (!channelRow) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (channelRow.channel === "in_app") {
      await handleInAppReply({
        req,
        res,
        conversationId,
        body,
      });
      return;
    }

    // SMS / email / voice path — keeps the original behavior.
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
          message:
            "This conversation is closed. Start a new one with the patient.",
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
          message:
            "The SMS/email vendor rejected the message. The attempt is in the audit log.",
        });
        return;
      case "unsupported_channel":
        // Should be unreachable — we early-branched on channel above
        // and route in-app conversations to handleInAppReply. This
        // case satisfies the exhaustive switch and surfaces a 500
        // if the dispatch split is ever undone.
        logger.error(
          {
            conversation_id: conversationId,
            channel: outcome.channel,
          },
          "POST /conversations/:id/reply: unsupported_channel reached the SMS/email dispatcher",
        );
        res.status(500).json({
          error: "internal",
          message: "Channel routing failed — please retry.",
        });
        return;
    }
  },
);

/**
 * In-app reply path. Persist the admin's outbound message, audit
 * with a non-PHI envelope, and best-effort send a notification email
 * to the customer with a link back to /account. The notification
 * email is intentionally subject-only (no body content) so the
 * email provider never sees PHI even though the body is plain.
 *
 * If SENDGRID_API_KEY isn't set (preview mode / dev) we skip the
 * notification — the customer will see the message next time they
 * sign in. We DO NOT 503 the route in that case; the message itself
 * has already landed in the DB.
 */
async function handleInAppReply(input: {
  req: import("express").Request;
  res: import("express").Response;
  conversationId: string;
  body: string;
}): Promise<void> {
  const { req, res, conversationId, body } = input;

  const outcome = await appendAdminInAppReply({
    pool: getDbPool(),
    conversationId,
    body,
  });

  switch (outcome.status) {
    case "ok":
      break;
    case "conversation_not_found":
      res.status(404).json({ error: "not_found" });
      return;
    case "conversation_closed":
      res.status(409).json({
        error: "conversation_closed",
        message: "This conversation is closed. Start a new one.",
      });
      return;
    case "wrong_channel":
      // Unreachable in practice — we branched on channel above.
      res.status(500).json({
        error: "internal",
        message: "Channel mismatch.",
      });
      return;
    case "missing_customer_id":
      // CHECK constraint should prevent this; treat as a corrupt row.
      logger.error(
        { conversation_id: conversationId },
        "in-app conversation has no customer_id (CHECK constraint violated upstream?)",
      );
      res.status(500).json({
        error: "internal",
        message: "Conversation is missing a subject id.",
      });
      return;
  }

  // Audit. Mirror the `messaging.reply.sent` envelope used by the
  // SMS/email dispatcher so reviewers can grep for "every reply"
  // across channels uniformly.
  await logAudit({
    action: "messaging.reply.sent",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "in_app",
      conversation_id: conversationId,
      message_id: outcome.result.messageId,
      status: "ok",
      body_length: body.length,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "messaging.reply.sent audit write failed (in_app)");
  });

  // Best-effort customer notification email. We look up the customer's
  // email at send time (NOT at conversation-create time) so a customer
  // who has updated their email after the thread started gets the
  // notification at the new address.
  await tryNotifyCustomerOfReply({
    conversationId,
    bodyLength: body.length,
  }).catch((err) => {
    logger.warn(
      { err, conversation_id: conversationId },
      "in-app reply notification email failed (the message itself was persisted)",
    );
  });

  res.status(201).json({
    messageId: outcome.result.messageId,
    conversationId,
    vendorRef: null,
  });
}

/**
 * Throttle window for in-app reply notification emails (Phase 13).
 * If a CSR posts multiple replies on the same thread within this
 * window, only the first triggers an email — subsequent replies are
 * silently swallowed (logged at debug level). The customer still
 * sees every message in /account on next sign-in.
 *
 * 15 min is short enough that a customer who's been away for a few
 * hours still gets a fresh nudge, but long enough to absorb a
 * multi-message CSR clarification ("Hi Anna — actually one more
 * question — and one more thing…").
 */
const IN_APP_NOTIFICATION_THROTTLE_MS = 15 * 60 * 1000;

async function tryNotifyCustomerOfReply(input: {
  conversationId: string;
  bodyLength: number;
}): Promise<void> {
  // Resolve the customer email from the conversation → shop_customers
  // join. If the customer has no email on file (rare but possible if
  // the auth provider hasn't sync'd yet) skip the send.
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      email: shopCustomers.emailLower,
      displayName: shopCustomers.displayName,
      prefs: shopCustomers.communicationPreferences,
      lastNotifiedAt: conversations.lastInAppNotificationAt,
    })
    .from(conversations)
    .innerJoin(
      shopCustomers,
      eq(shopCustomers.customerId, conversations.customerId),
    )
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.email) {
    return;
  }

  // Customer comm-prefs opt-out (Phase 12). The default is ON so a
  // null/missing prefs row keeps today's behavior; the toggle on
  // /account flips this to false to mute reply-notification emails.
  // We coalesce missing keys against DEFAULT_COMMUNICATION_PREFERENCES
  // so a customer whose row predates the new key still gets the
  // notification (rather than spuriously failing-closed to "muted").
  const prefs: CommunicationPreferences = {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...((row.prefs ?? {}) as Partial<CommunicationPreferences>),
  };
  if (!prefs.emailInAppReplyNotifications) {
    return;
  }

  // Throttle: skip if we've sent a notification on this thread within
  // the throttle window. Phase 13. Null = never sent (or pre-13 row),
  // which always passes the gate. Guard against future timestamps
  // (clock skew / bad data) so we do not accidentally mute this thread
  // until wall-clock time catches up.
  if (row.lastNotifiedAt) {
    const sinceMs = Date.now() - row.lastNotifiedAt.getTime();
    if (sinceMs < 0) {
      logger.warn(
        {
          conversation_id: input.conversationId,
          last_notified_at: row.lastNotifiedAt.toISOString(),
          since_ms: sinceMs,
          throttle_ms: IN_APP_NOTIFICATION_THROTTLE_MS,
        },
        "in_app_reply_notification: future lastNotifiedAt; bypassing throttle",
      );
    } else if (sinceMs < IN_APP_NOTIFICATION_THROTTLE_MS) {
      logger.debug(
        {
          conversation_id: input.conversationId,
          since_ms: sinceMs,
          throttle_ms: IN_APP_NOTIFICATION_THROTTLE_MS,
        },
        "in_app_reply_notification: throttled (recent send on same thread)",
      );
      return;
    }
  }

  let sg;
  try {
    sg = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Preview / dev — no SENDGRID_API_KEY. Skip silently. The
      // message is in the DB; customer will see it on next sign-in.
      return;
    }
    throw err;
  }

  // Subject + body deliberately contain ZERO message content. This is
  // a "you have a new message" nudge; the customer signs in to read
  // it. Keeps PHI out of the email provider's hands.
  const greeting = row.displayName
    ? `Hi ${row.displayName.split(" ")[0]}`
    : "Hi";
  await sg.sendEmail({
    to: row.email,
    subject: "New message from PennPaps customer service",
    text:
      `${greeting},\n\n` +
      `You have a new message from the PennPaps customer-service team.\n\n` +
      `Sign in to your account at https://pennpaps.com/account to read and reply.\n\n` +
      `— Penn Home Medical Supply\n`,
    html:
      `<p>${greeting},</p>` +
      `<p>You have a new message from the PennPaps customer-service team.</p>` +
      `<p><a href="https://pennpaps.com/account" style="color: #003B71">Sign in to your account</a> to read and reply.</p>` +
      `<p style="color: #6b7280; font-size: 12px">Penn Home Medical Supply</p>`,
    customArgs: {
      conversation_id: input.conversationId,
      kind: "in_app_reply_notification",
    },
  });

  // Stamp the throttle timestamp AFTER a successful SendGrid send.
  // Stamping before would make a SendGrid 5xx silently mute the next
  // reply too, which is wrong — we want the next reply to retry.
  // The rare race where two replies dispatch concurrently before the
  // first stamp lands is acceptable for a notification email.
  await db
    .update(conversations)
    .set({ lastInAppNotificationAt: new Date() })
    .where(eq(conversations.id, input.conversationId));
}

export default router;
