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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
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
import { buildResupplyDueItems } from "../../lib/messaging/resupply-due-items";
import type { ClickLandingItem } from "@workspace/resupply-messaging";
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
  const supabase = getSupabaseServiceRoleClient();
  const { data: convRow, error: convErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, episode_id")
    .eq("id", verified.conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;

  if (!convRow) {
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

  // Enrich the confirm landing page with the supplies that are due so
  // the patient sees exactly what's shipping before they tap. Fail
  // soft: any lookup error renders the page without the list rather
  // than 500-ing the patient's link.
  let dueItems: ClickLandingItem[] = [];
  if (verified.action === "confirm" && convRow.episode_id) {
    try {
      dueItems = await buildResupplyDueItems(supabase, convRow.episode_id);
    } catch (err) {
      logger.warn(
        {
          event: "email_click_due_items_failed",
          err: serializeErr(err),
        },
        "email.click: due-items lookup failed; rendering landing without list",
      );
    }
  }

  res
    .status(200)
    .type("text/html")
    .send(
      renderClickLanding({
        practiceName: cfg.practiceName,
        action: verified.action,
        formActionUrl,
        items: dueItems,
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

  const supabase = getSupabaseServiceRoleClient();
  const { data: conv, error: convErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, patient_id, episode_id")
    .eq("id", conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  // Post-0033 conversations.patient_id is nullable so in-app shop-
  // customer threads can omit it. Email click links are minted only
  // for SMS/email patient-flow conversations, but defensively reject
  // a null patient_id here so the rest of the handler can treat the
  // value as a string.
  if (!conv || !conv.patient_id) {
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
      patient_id: conv.patient_id,
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
          const { error: closeErr } = await supabase
            .schema("resupply")
            .from("conversations")
            .update({
              status: "closed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
          if (closeErr) throw closeErr;
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
        if (result.status === "not_eligible") {
          // Entitlement guard blocked the reship (too soon / over the
          // per-period cap). order-flow already raised a CSR alert and
          // left the episode pending. Render a truthful "we'll review"
          // page (200, not an error), flip the conversation to
          // awaiting_admin (lands in the CSR queue), and audit the block.
          const { error: notEligErr } = await supabase
            .schema("resupply")
            .from("conversations")
            .update({
              status: "awaiting_admin",
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
          if (notEligErr) throw notEligErr;
          await safeAudit({
            action: "messaging.order.blocked_not_eligible",
            adminEmail: null,
            adminUserId: null,
            targetTable: "episodes",
            targetId: result.episodeId,
            metadata: {
              channel: "email",
              conversation_id: conversationId,
              patient_id: result.patientId,
              episode_id: result.episodeId,
              entitlement_status: result.entitlement.status,
              hcpcs_code: result.entitlement.hcpcsCode,
              days_until_eligible: result.entitlement.daysUntilEligible,
              via: "email_link",
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
                action: "review",
              }),
            );
          return;
        }
        if (result.status === "coverage_blocked") {
          // Coverage guard held the reship (inactive plan / PA required
          // on the last 271). order-flow already raised a CSR alert and
          // left the episode pending. Route the conversation to the CSR
          // queue, audit the block, and render the same truthful
          // "we'll review" page (200, not an error).
          const { error: covErr } = await supabase
            .schema("resupply")
            .from("conversations")
            .update({
              status: "awaiting_admin",
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
          if (covErr) throw covErr;
          await safeAudit({
            action: "messaging.order.blocked_coverage",
            adminEmail: null,
            adminUserId: null,
            targetTable: "episodes",
            targetId: result.episodeId,
            metadata: {
              channel: "email",
              conversation_id: conversationId,
              patient_id: result.patientId,
              episode_id: result.episodeId,
              coverage_reason: result.coverage.reason,
              eligibility_check_id: result.coverage.eligibilityCheckId,
              via: "email_link",
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
                action: "review",
              }),
            );
          return;
        }
        if (result.status === "usage_review") {
          // Continued-use guard held the reship (recent therapy data
          // shows the device is effectively unused — a continued-use
          // claim-denial risk). order-flow already raised a CSR alert
          // and left the episode pending. Same handling as the other
          // two guards: CSR queue, audit, truthful "we'll review" page.
          const { error: usageErr } = await supabase
            .schema("resupply")
            .from("conversations")
            .update({
              status: "awaiting_admin",
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
          if (usageErr) throw usageErr;
          await safeAudit({
            action: "messaging.order.blocked_usage_review",
            adminEmail: null,
            adminUserId: null,
            targetTable: "episodes",
            targetId: result.episodeId,
            metadata: {
              channel: "email",
              conversation_id: conversationId,
              patient_id: result.patientId,
              episode_id: result.episodeId,
              data_nights: result.usage.dataNights,
              compliant_nights: result.usage.compliantNights,
              window_days: result.usage.windowDays,
              via: "email_link",
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
                action: "review",
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
        const { error: editErr } = await supabase
          .schema("resupply")
          .from("conversations")
          .update({
            status: "awaiting_admin",
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
        if (editErr) throw editErr;
        await safeAudit({
          action: "messaging.handoff.escalated",
          adminEmail: null,
          adminUserId: null,
          targetTable: "conversations",
          targetId: conversationId,
          metadata: {
            channel: "email",
            conversation_id: conversationId,
            patient_id: conv.patient_id,
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
        await pausePatient(conv.patient_id);
        const { error: stopErr } = await supabase
          .schema("resupply")
          .from("conversations")
          .update({
            status: "closed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
        if (stopErr) throw stopErr;
        await safeAudit({
          action: "messaging.handoff.escalated",
          adminEmail: null,
          adminUserId: null,
          targetTable: "patients",
          targetId: conv.patient_id,
          metadata: {
            channel: "email",
            conversation_id: conversationId,
            patient_id: conv.patient_id,
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
