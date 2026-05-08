// GET  /email/click?t=<token> — renders a confirmation landing page.
// POST /email/click?t=<token> — performs the signed action.
//
// WHY TWO STEPS:
//   Email security scanners (Outlook ATP, Gmail link-warmer, Proofpoint,
//   Mimecast, etc.) pre-fetch every link in an outbound email via GET to
//   check for malware and phishing. If GET performs a state-changing action
//   — confirming an order, pausing reminders, escalating an address change —
//   the scanner wins the race and the patient never actually chose anything.
//   Idempotency only prevents the second trigger; it cannot prevent the
//   FIRST unauthorised side-effect.
//
//   Separating the two verbs fixes this cleanly:
//     • GET  → verify the token, render a human-readable landing page with
//               a single POST <form> button. No DB writes, no side effects.
//               A scanner sees an HTML page and moves on.
//     • POST → verify the token again (re-entrant, safe to repeat), then
//               perform the action. POST requests are never pre-fetched by
//               mail scanners (RFC 7231 §4.2.1 — POST is not safe/idempotent
//               so intermediaries must not auto-submit it).
//
// Security:
//   - Both GET and POST verify the HMAC token so an expired/forged token
//     cannot perform any action.
//   - Conversation lookup fails → generic "link no longer valid" page.
//   - Signature mismatch / malformed → same generic page (no detail leak).

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { conversations, getDbPool } from "@workspace/resupply-db";
import {
  renderClickConfirmation,
  renderClickError,
  renderClickLanding,
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

// /email/click is publicly reachable (it accepts a signed token via
// query string). The signature is enough to keep an attacker from
// performing actions, but a flood of requests with garbage tokens
// still walks the verifyLinkToken HMAC and (on the GET path) issues
// a DB lookup. Cap per IP so an abusive client cannot run that work
// in a tight loop.
const emailClickLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

/**
 * Parse and verify the `?t=` token from a request's query string.
 * Returns the verified payload or null (after sending an error response).
 */
function extractVerifiedToken(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  practiceName: string,
) {
  const token = typeof req.query.t === "string" ? req.query.t : null;
  if (!token) {
    res
      .status(400)
      .type("text/html")
      .send(renderClickError({ practiceName, reason: "malformed" }));
    return null;
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
      .send(renderClickError({ practiceName, reason: verified.reason }));
    return null;
  }
  return verified;
}

// ---------------------------------------------------------------------------
// GET — landing page only (no side-effects)
// ---------------------------------------------------------------------------

router.get("/email/click", emailClickLimiter, async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res
      .status(503)
      .type("text/html")
      .send(
        renderClickError({ practiceName: "the practice", reason: "malformed" }),
      );
    return;
  }

  const verified = extractVerifiedToken(req, res, cfg.practiceName);
  if (!verified) return;

  // Audit the link open (no state change — audit is informational only).
  const pool = getDbPool();
  const db = drizzle(pool);
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, verified.conversationId))
    .limit(1);

  if (!convRows[0]) {
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
    action: "email.link.opened",
    adminEmail: null,
    adminUserId: null,
    targetTable: "conversations",
    targetId: verified.conversationId,
    metadata: {
      channel: "email",
      conversation_id: verified.conversationId,
      link_action: verified.action,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  // Build the form action URL so the POST carries the same signed token.
  const formActionUrl = `${cfg.email.publicBaseUrl}/resupply-api/email/click?t=${encodeURIComponent(typeof req.query.t === "string" ? req.query.t : "")}`;

  res
    .status(200)
    .type("text/html")
    .send(
      renderClickLanding({
        practiceName: cfg.practiceName,
        action: verified.action,
        formActionUrl,
      }),
    );
});

// ---------------------------------------------------------------------------
// POST — perform the signed action
// ---------------------------------------------------------------------------

router.post("/email/click", emailClickLimiter, async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    res
      .status(503)
      .type("text/html")
      .send(
        renderClickError({ practiceName: "the practice", reason: "malformed" }),
      );
    return;
  }

  const verified = extractVerifiedToken(req, res, cfg.practiceName);
  if (!verified) return;

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
  // Post-0033 conversations.patientId is nullable so in-app shop-
  // customer threads can omit it. Email click links are minted only
  // for SMS/email patient-flow conversations, but defensively reject
  // a null patientId here so the rest of the handler can treat the
  // value as a string.
  if (!conv || !conv.patientId) {
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
    adminUserId: null,
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
              adminUserId: null,
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
          } else {
            // already_confirmed: order placed on an earlier click/request.
            // Closing the conversation is still correct; audit the duplicate
            // so admins can see the full lifecycle in the audit log.
            await safeAudit({
              action: "messaging.order.already_confirmed",
              adminEmail: null,
              adminUserId: null,
              targetTable: "conversations",
              targetId: conversationId,
              metadata: {
                channel: "email",
                conversation_id: conversationId,
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
          adminUserId: null,
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
          adminUserId: null,
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

export default router;
