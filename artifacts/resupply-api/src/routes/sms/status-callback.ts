// POST /sms/status-callback — Twilio SMS delivery status webhook.
//
// Twilio POSTs lifecycle transitions for outbound messages: queued,
// sending, sent, delivered, undelivered, failed. We persist the
// terminal-state delivery_status onto the messages row keyed by
// MessageSid (we stamped the SID into vendorMetadata at send time)
// and audit any failure so the admin inbox can surface bounces.
//
// Two outbound SMS paths have NO messages row, so their sends bake the
// owning row's id into the callback URL instead of `conversationId`;
// Twilio signs the full URL including the query string, so the id is
// authenticated by the signature middleware. When present we stamp the
// delivery outcome onto that row and skip the messages lookup entirely:
//   * `recallNotificationId=<id>` — recall_notifications (recall sweep).
//   * `videoVisitId=<id>`         — video_visits (telehealth invite
//     SMS; columns from migration 0315).
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
  const rawRecallId = req.query.recallNotificationId;
  const recallNotificationId =
    typeof rawRecallId === "string" && /^[0-9a-f-]{36}$/i.test(rawRecallId)
      ? rawRecallId
      : null;
  const rawVideoVisitId = req.query.videoVisitId;
  const videoVisitId =
    typeof rawVideoVisitId === "string" &&
    /^[0-9a-f-]{36}$/i.test(rawVideoVisitId)
      ? rawVideoVisitId
      : null;

  const messageSid = parsed.MessageSid;
  const status = parsed.MessageStatus;

  if (!TERMINAL_STATUSES.has(status)) {
    // Intermediate states (queued/sending) — ignore quietly.
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  if (recallNotificationId) {
    await updateRecallNotificationDelivery(
      recallNotificationId,
      messageSid,
      status,
      parsed.ErrorCode ?? null,
    );
  } else if (videoVisitId) {
    await updateVideoVisitInviteDelivery(
      videoVisitId,
      messageSid,
      status,
      parsed.ErrorCode ?? null,
    );
  } else {
    await updateMessageDelivery(messageSid, status, parsed.ErrorCode ?? null);
  }

  if (FAILURE_STATUSES.has(status)) {
    await safeAudit({
      action: "messaging.delivery.failed",
      adminEmail: null,
      adminUserId: null,
      targetTable: recallNotificationId
        ? "recall_notifications"
        : videoVisitId
          ? "video_visits"
          : "messages",
      targetId: recallNotificationId ?? videoVisitId,
      metadata: {
        channel: "sms",
        conversation_id: conversationId,
        recall_notification_id: recallNotificationId,
        video_visit_id: videoVisitId,
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

/**
 * Stamp a terminal delivery status onto the messages row that carries
 * this MessageSid in its vendor metadata. Never throws — Twilio retries
 * 5xx, which would amplify any downstream incident.
 */
async function updateMessageDelivery(
  messageSid: string,
  status: string,
  errorCode: string | null,
): Promise<void> {
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
      delivery_error: errorCode,
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
}

/**
 * Stamp a terminal delivery status onto a recall_notifications row,
 * keyed by primary key (the id rode in the signed callback URL). Also
 * stamps the SID — the callback can land before the send sweep's
 * terminal flip writes it. Touches ONLY the delivery_* columns, never
 * `status`: that column is the send sweep's state machine and a webhook
 * must not race it. Never throws (same retry-amplification rationale).
 */
async function updateRecallNotificationDelivery(
  recallNotificationId: string,
  messageSid: string,
  status: string,
  errorCode: string | null,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    let updateQuery = supabase
      .schema("resupply")
      .from("recall_notifications")
      .update({
        delivery_status: status,
        delivery_error_code: errorCode,
        twilio_message_sid: messageSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", recallNotificationId);
    if (status === "sent") {
      // Same no-regress rule as the messages path: callbacks are
      // unordered and re-POSTed, so a late `sent` must never downgrade
      // a row that already reached delivered/undelivered/failed.
      updateQuery = updateQuery.or(
        "delivery_status.is.null,delivery_status.not.in.(delivered,undelivered,failed)",
      );
    }
    const { error } = await updateQuery;
    if (error) throw error;
  } catch (err) {
    logger.warn(
      {
        event: "sms_status_recall_update_failed",
        message_sid: messageSid,
        recall_notification_id: recallNotificationId,
        err: serializeErr(err),
      },
      "sms.status-callback: failed to update recall_notifications row",
    );
  }
}

/**
 * Stamp a terminal invite-delivery status onto a video_visits row,
 * keyed by primary key (the id rode in the signed callback URL). Also
 * stamps the SID — the callback can land before the send path writes
 * it. Touches ONLY the invite_delivery_* columns, never `status` or
 * `invite_delivered`: those belong to the visit lifecycle / send path
 * and a webhook must not race them. Never throws (same
 * retry-amplification rationale as the paths above).
 */
async function updateVideoVisitInviteDelivery(
  videoVisitId: string,
  messageSid: string,
  status: string,
  errorCode: string | null,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    let updateQuery = supabase
      .schema("resupply")
      .from("video_visits")
      .update({
        invite_delivery_status: status,
        invite_delivery_error_code: errorCode,
        invite_twilio_message_sid: messageSid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", videoVisitId);
    if (status === "sent") {
      // Same no-regress rule as the paths above: callbacks are
      // unordered and re-POSTed, so a late `sent` must never downgrade
      // a row that already reached delivered/undelivered/failed.
      updateQuery = updateQuery.or(
        "invite_delivery_status.is.null,invite_delivery_status.not.in.(delivered,undelivered,failed)",
      );
    }
    const { error } = await updateQuery;
    if (error) throw error;
  } catch (err) {
    logger.warn(
      {
        event: "sms_status_video_visit_update_failed",
        message_sid: messageSid,
        video_visit_id: videoVisitId,
        err: serializeErr(err),
      },
      "sms.status-callback: failed to update video_visits row",
    );
  }
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
