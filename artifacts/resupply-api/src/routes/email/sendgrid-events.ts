// POST /email/sendgrid-events — SendGrid Event Webhook receiver.
//
// SendGrid POSTs a JSON array of event objects (delivered, bounce,
// dropped, deferred, processed, open, click, etc). We:
//   1. Validate the ECDSA signature against the raw body. Reject unsigned.
//   2. Parse with our zod schema (passthrough on unknown event kinds).
//   3. For each event whose kind we care about (delivered, bounce,
//      dropped, deferred), update the matching messages row by
//      sendgrid_message_id and audit failures.
//
// Why we mount with `express.raw({ type: "application/json" })`:
//   The signature is over the raw bytes the request body parser saw.
//   Express's global JSON parser would have already consumed those
//   bytes by the time our handler runs. We re-parse the buffer
//   ourselves after validating.

import {
  Router,
  raw,
  type IRouter,
  type RequestHandler,
} from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool } from "@workspace/resupply-db";
import {
  parseSendgridEventBatch,
  requireSendgridSignature,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { readEmailConfigOrNull } from "../../lib/messaging/messaging-config";
import { safeAudit } from "../../lib/messaging/safe-audit";

const router: IRouter = Router();

// Cast to express's RequestHandler — the middleware's structural
// signature (SendgridSigRequestLike / SendgridSigResponseLike) keeps
// the lib testable in isolation, but Express's overload resolution
// otherwise narrows res to the structural shape (no `.json()`).
// We pass no `publicKeyBase64` so the middleware reads the env at
// request time — secret rotation does not require a process restart.
const sigMiddleware = requireSendgridSignature() as unknown as RequestHandler;

router.post(
  "/email/sendgrid-events",
  // Raw body capture must run BEFORE the signature middleware so the
  // signature has bytes to verify.
  raw({ type: "application/json", limit: "1mb" }),
  sigMiddleware,
  async (req, res) => {
    if (!readEmailConfigOrNull()) {
      // Should be unreachable — sigMiddleware would have 403'd.
      res.status(503).json({ error: "messaging_not_configured" });
      return;
    }

    let events;
    try {
      const buf = req.body as Buffer;
      const parsed = JSON.parse(buf.toString("utf8"));
      events = parseSendgridEventBatch(parsed);
    } catch (err) {
      logger.warn(
        { event: "sendgrid_events_parse_failed", err: serializeErr(err) },
        "sendgrid-events: parse failed",
      );
      // 200 — SendGrid retries 5xx. Don't amplify.
      res.status(200).json({ ok: true });
      return;
    }

    const pool = getDbPool();
    const db = drizzle(pool);

    for (const ev of events) {
      const sgMessageId = ev.sg_message_id ?? null;
      const conversationId = ev.conversation_id ?? null;

      try {
        // Map SendGrid event names to our delivery_status taxonomy.
        const statusUpdate = mapEventToStatus(ev.event);
        if (statusUpdate && sgMessageId) {
          await db.execute(sql`
            update resupply.messages
            set
              delivery_status = ${statusUpdate.deliveryStatus},
              delivery_error = ${statusUpdate.deliveryError ?? null},
              delivered_at = case when ${statusUpdate.deliveryStatus} = 'delivered' then now() else delivered_at end
            where vendor_metadata->>'sendgrid_message_id' = ${sgMessageId}
          `);
        }
      } catch (err) {
        logger.warn(
          {
            event: "sendgrid_events_update_failed",
            sg_message_id: sgMessageId,
            err: serializeErr(err),
          },
          "sendgrid-events: failed to update messages row",
        );
      }

      if (ev.event === "bounce" || ev.event === "dropped") {
        // PHI safety: SendGrid `reason` is freeform vendor text and
        // routinely echoes the recipient address (e.g. "550 5.1.1
        // <patient@example.com>: User unknown"). We refuse to write it
        // to the audit row. SendGrid `type` is a small enumerated set
        // for bounce events (`bounce`, `blocked`, `expired`, etc.) —
        // we whitelist it through a fixed vocabulary, falling back to
        // `other` rather than echoing whatever the vendor sent.
        // The freeform reason is preserved on the `messages` row above
        // (encrypted at rest), where investigators can pull it via the
        // bound conversation_id without it leaking into the operator
        // audit feed.
        await safeAudit({
          action: "email.delivery.bounced",
          operatorEmail: null,
          operatorClerkId: null,
          targetTable: "messages",
          targetId: null,
          metadata: {
            channel: "email",
            conversation_id: conversationId,
            sendgrid_message_id: sgMessageId,
            event: ev.event,
            bounce_classification: classifyBounceType(ev.type),
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
      }
    }

    res.status(200).json({ ok: true });
  },
);

/**
 * Whitelist SendGrid bounce-event `type` strings into a small fixed
 * vocabulary that we are comfortable surfacing on the operator audit
 * feed. Anything outside the known set collapses to `other` rather
 * than echoing untrusted vendor text.
 *
 * SendGrid's documented bounce types as of 2026:
 *   bounce  — generic SMTP bounce (the default)
 *   blocked — recipient mail server rejected at SMTP time
 *   expired — message timed out in retry queue
 * We keep the mapping permissive (any of the three is acceptable
 * vocabulary) but anything else (including `null`/`undefined`) is
 * normalized to `other`.
 */
function classifyBounceType(raw: string | undefined | null): string {
  switch (raw) {
    case "bounce":
    case "blocked":
    case "expired":
      return raw;
    default:
      return "other";
  }
}

function mapEventToStatus(
  event: string,
): { deliveryStatus: string; deliveryError?: string } | null {
  switch (event) {
    case "delivered":
      return { deliveryStatus: "delivered" };
    case "bounce":
      return { deliveryStatus: "bounced", deliveryError: "bounce" };
    case "dropped":
      return { deliveryStatus: "dropped", deliveryError: "dropped" };
    case "deferred":
      return { deliveryStatus: "deferred" };
    case "processed":
      return { deliveryStatus: "sent" };
    default:
      return null;
  }
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
