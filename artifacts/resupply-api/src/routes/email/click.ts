// GET /email/click?t=<token> — public link-click handler for the three
// signed actions (confirm, edit, stop) embedded in outbound reminder
// emails.
//
// Why GET (and not POST):
//   Email clients open links with GET. We cannot POST from a plain
//   <a href>. Mitigations against the GET-side-effect concerns:
//     - Tokens are HMAC-signed AND short-TTL (7 days).
//     - Tokens are SINGLE-PURPOSE (action is baked into the payload).
//     - Email link previews from corporate scanners (Outlook ATP,
//       Gmail link-warmer) WILL fire these GETs. The downstream
//       handlers are idempotent: confirm twice = one fulfillment;
//       stop twice = still paused; edit twice = still
//       awaiting_admin. We do NOT block the action on a "human
//       click" check — false negatives there would break legitimate
//       Outlook users whose corporate proxy strips Referer.
//
// Security:
//   - Signature mismatch / expired / malformed → generic "this link
//     is no longer valid" page (no detail).
//   - Conversation lookup fails → same generic page (do NOT confirm
//     "this conversation does not exist" — that's a leak vector).

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { conversations, getDbPool } from "@workspace/resupply-db";
import {
  renderClickConfirmation,
  renderClickError,
  verifyLinkToken,
} from "@workspace/resupply-messaging";

import { logger } from "../../lib/logger";
import { readMessagingConfigOrNull } from "../../lib/messaging/messaging-config";
import {
  pausePatient,
  placeResupplyOrderForConversation,
} from "../../lib/messaging/order-flow";
import { safeAudit } from "../../lib/messaging/safe-audit";

const router: IRouter = Router();

router.get("/email/click", async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res
      .status(503)
      .type("text/html")
      .send(
        renderClickError({
          practiceName: "the practice",
          reason: "malformed",
        }),
      );
    return;
  }

  const token = typeof req.query.t === "string" ? req.query.t : null;
  if (!token) {
    res
      .status(400)
      .type("text/html")
      .send(
        renderClickError({
          practiceName: cfg.practiceName,
          reason: "malformed",
        }),
      );
    return;
  }

  const verified = verifyLinkToken(token);
  if (!verified.valid) {
    logger.info(
      { event: "email_click_token_invalid", reason: verified.reason },
      "email.click: token rejected",
    );
    res
      .status(400)
      .type("text/html")
      .send(
        renderClickError({
          practiceName: cfg.practiceName,
          reason: verified.reason,
        }),
      );
    return;
  }

  const { conversationId, action } = verified;

  const pool = getDbPool();
  const db = drizzle(pool);
  const convRows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      episodeId: conversations.episodeId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) {
    // Generic error — do NOT leak that the conversation was deleted.
    res
      .status(400)
      .type("text/html")
      .send(
        renderClickError({
          practiceName: cfg.practiceName,
          reason: "malformed",
        }),
      );
    return;
  }

  await safeAudit({
    action: "email.link.clicked",
    adminEmail: null,
    adminClerkId: null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "email",
      conversation_id: conversationId,
      patient_id: conv.patientId,
      link_action: action,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  try {
    switch (action) {
      case "confirm": {
        const result = await placeResupplyOrderForConversation({
          conversationId,
        });
        if (result.status === "ok" || result.status === "already_confirmed") {
          await db
            .update(conversations)
            .set({ status: "closed", updatedAt: new Date() })
            .where(eq(conversations.id, conversationId));
          if (result.status === "ok") {
            await safeAudit({
              action: "messaging.order.confirmed",
              adminEmail: null,
              adminClerkId: null,
              targetTable: "episodes",
              targetId: result.episodeId,
              metadata: {
                channel: "email",
                conversation_id: conversationId,
                patient_id: result.patientId,
                episode_id: result.episodeId,
                fulfillment_count: result.fulfillmentIds.length,
                via: "email_link",
              },
              ip: req.ip ?? null,
              userAgent: req.get("user-agent") ?? null,
            });
          }
          res
            .status(200)
            .type("text/html")
            .send(
              renderClickConfirmation({
                practiceName: cfg.practiceName,
                action: "confirm",
              }),
            );
          return;
        }
        // Episode not found / no prescription / etc — render error.
        res
          .status(400)
          .type("text/html")
          .send(
            renderClickError({
              practiceName: cfg.practiceName,
              reason: "malformed",
            }),
          );
        return;
      }
      case "edit": {
        await db
          .update(conversations)
          .set({ status: "awaiting_admin", updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        await safeAudit({
          action: "messaging.handoff.escalated",
          adminEmail: null,
          adminClerkId: null,
          targetTable: "conversations",
          targetId: conversationId,
          metadata: {
            channel: "email",
            conversation_id: conversationId,
            patient_id: conv.patientId,
            reason: "edit_address_link",
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
        res
          .status(200)
          .type("text/html")
          .send(
            renderClickConfirmation({
              practiceName: cfg.practiceName,
              action: "edit",
            }),
          );
        return;
      }
      case "stop": {
        await pausePatient(conv.patientId);
        await db
          .update(conversations)
          .set({ status: "closed", updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
        await safeAudit({
          action: "messaging.handoff.escalated",
          adminEmail: null,
          adminClerkId: null,
          targetTable: "patients",
          targetId: conv.patientId,
          metadata: {
            channel: "email",
            conversation_id: conversationId,
            patient_id: conv.patientId,
            reason: "stop_link",
            patient_status: "paused",
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
        res
          .status(200)
          .type("text/html")
          .send(
            renderClickConfirmation({
              practiceName: cfg.practiceName,
              action: "stop",
            }),
          );
        return;
      }
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        res
          .status(400)
          .type("text/html")
          .send(
            renderClickError({
              practiceName: cfg.practiceName,
              reason: "unknown-action",
            }),
          );
        return;
      }
    }
  } catch (err) {
    logger.error(
      {
        event: "email_click_dispatch_crashed",
        err: serializeErr(err),
        conversation_id: conversationId,
        action,
      },
      "email.click: dispatch crashed",
    );
    res
      .status(500)
      .type("text/html")
      .send(
        renderClickError({
          practiceName: cfg.practiceName,
          reason: "malformed",
        }),
      );
  }
});

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
