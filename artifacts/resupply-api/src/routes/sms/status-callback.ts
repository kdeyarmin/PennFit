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

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  parseSmsStatusCallbackParams,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { readSmsConfigOrNull } from "../../lib/messaging/messaging-config";
import { safeAudit } from "../../lib/messaging/safe-audit";

type MessagesUpdate = Database["resupply"]["Tables"]["messages"]["Update"];

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

router.post("/sms/status-callback", signatureMiddleware, async (req, res) => {
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

  const rawConvId = req.query.conversationId;
  const conversationId =
    typeof rawConvId === "string" && /^[0-9a-f-]{36}$/i.test(rawConvId)
      ? rawConvId
      : null;

  const messageSid = parsed.MessageSid;
  const status = parsed.MessageStatus;

  if (!TERMINAL_STATUSES.has(status)) {
    // Intermediate states (queued/sending) — ignore quietly.
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    // Update the messages row whose vendor_metadata.twilio_message_sid
    // matches. PostgREST supports the `->>` JSON-text-extract filter
    // natively. The original SQL had a conditional `delivered_at = case
    // when status = 'delivered' then now() else delivered_at end`;
    // we get the same effect by only setting delivered_at when the
    // status transitions to 'delivered' (omitting the column preserves
    // its existing value).
    const update: MessagesUpdate = {
      delivery_status: status,
      delivery_error: parsed.ErrorCode ?? null,
    };
    if (status === "delivered") {
      update.delivered_at = new Date().toISOString();
    }
    let updateQuery = supabase
      .schema("resupply")
      .from("messages")
      .update(update)
      .filter("vendor_metadata->>twilio_message_sid", "eq", messageSid);
    if (status === "sent") {
      // `sent` (carrier-accepted) is NOT a final state — `delivered`,
      // `undelivered`, and `failed` are. Twilio status callbacks are not
      // ordered and can be re-POSTed, so a late or duplicate `sent` must
      // never regress a row that already reached a final state (which
      // would downgrade a confirmed delivery or, worse, hide a real
      // delivery failure in the inbox). Apply `sent` only when the row
      // has not reached a final state yet (NULL-safe for a brand-new row).
      updateQuery = updateQuery.or(
        "delivery_status.is.null,delivery_status.not.in.(delivered,undelivered,failed)",
      );
    }
    const { error } = await updateQuery;
    if (error) throw error;
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
      adminUserId: null,
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
});

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
