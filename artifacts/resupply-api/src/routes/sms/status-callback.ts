// POST /sms/status-callback — Twilio SMS delivery status webhook.
//
// Twilio POSTs lifecycle transitions for outbound messages: queued,
// sending, sent, delivered, undelivered, failed. We persist the
// terminal-state delivery_status onto the messages row keyed by
// MessageSid (we stamped the SID into vendorMetadata at send time)
// and audit any failure so the admin inbox can surface bounces.
//
// 200 every signed request. Twilio retries 5xx with exponential
// backoff, which would amplify any downstream incident.

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool } from "@workspace/resupply-db";
import {
  parseSmsStatusCallbackParams,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { readSmsConfigOrNull } from "../../lib/messaging/messaging-config";
import { safeAudit } from "../../lib/messaging/safe-audit";

const router: IRouter = Router();

const TERMINAL_STATUSES = new Set([
  "delivered",
  "undelivered",
  "failed",
  "sent",
]);
const FAILURE_STATUSES = new Set(["undelivered", "failed"]);

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readSmsConfigOrNull()?.twilioAuthToken,
  buildPublicUrl: (req) => {
    const base = readSmsConfigOrNull()?.publicBaseUrl ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post(
  "/sms/status-callback",
  signatureMiddleware,
  async (req, res) => {
    let parsed;
    try {
      parsed = parseSmsStatusCallbackParams(req.body);
    } catch (err) {
      logger.warn(
        { event: "sms_status_invalid_body", err: serializeErr(err) },
        "sms.status-callback: invalid body",
      );
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    const conversationId =
      typeof req.query.conversationId === "string"
        ? req.query.conversationId
        : null;

    const messageSid = parsed.MessageSid;
    const status = parsed.MessageStatus;

    if (!TERMINAL_STATUSES.has(status)) {
      // Intermediate states (queued/sending) — ignore quietly.
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    const pool = getDbPool();
    const db = drizzle(pool);
    try {
      // Update the messages row whose vendorMetadata.twilio_message_sid
      // matches. We can't FK on this so we use a jsonb predicate.
      await db.execute(sql`
        update resupply.messages
        set
          delivery_status = ${status},
          delivery_error = ${parsed.ErrorCode ?? null},
          delivered_at = case when ${status} = 'delivered' then now() else delivered_at end
        where vendor_metadata->>'twilio_message_sid' = ${messageSid}
      `);
    } catch (err) {
      // Don't 500 — Twilio retries amplify the issue.
      logger.warn(
        {
          event: "sms_status_update_failed",
          message_sid: messageSid,
          err: serializeErr(err),
        },
        "sms.status-callback: failed to update messages row",
      );
    }

    if (FAILURE_STATUSES.has(status)) {
      await safeAudit({
        action: "messaging.delivery.failed",
        adminEmail: null,
        adminClerkId: null,
        targetTable: "messages",
        targetId: null,
        metadata: {
          channel: "sms",
          conversation_id: conversationId,
          twilio_message_sid: messageSid,
          status,
          error_code: parsed.ErrorCode ?? null,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
    }

    res.status(200).type("text/xml").send("<Response/>");
    return;
  },
);

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
