// /shop/me/messages — in-account customer-service messaging.
//
//   GET  /shop/me/messages     — returns the customer's in-app thread
//                                 + every message in chronological
//                                 order. Empty thread is null +
//                                 empty array (not 404) so the UI
//                                 can render an empty-state cleanly.
//   POST /shop/me/messages     — append a new message from the
//                                 customer. Lazy-creates the thread
//                                 on first use. Always idempotency-
//                                 keyed at the route layer.
//
// Why no separate "open new thread" endpoint: v1 policy is one thread
// per customer (mirrors the /admin/conversations layout for SMS where
// each patient has at most one open thread per channel). The
// customer's first POST creates the thread; subsequent POSTs append.
// We can revisit if support actually asks for thread-per-topic.
//
// Audit: each customer message writes a `shop_customer.message.send`
// audit row with structural metadata only (no body). Mirrors the
// `messaging.reply.sent` envelope used by the admin replyInConversation
// helper, so the audit_log surface stays uniform across channels.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import {
  IN_APP_MESSAGE_BODY_MAX,
  appendCustomerMessage,
  fetchInAppThread,
} from "../../lib/messaging/in-app-conversation";
import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const postBody = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Message cannot be empty.")
      .max(
        IN_APP_MESSAGE_BODY_MAX,
        `Message must be ${IN_APP_MESSAGE_BODY_MAX} characters or fewer.`,
      ),
  })
  .strict();

router.get("/shop/me/messages", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId!;
  // Make sure the row exists so future PUT /shop/me writes don't fail
  // on a fresh account that has only ever messaged.
  await ensureShopCustomerRow({ customerId, email: null });
  const result = await fetchInAppThread({
    pool: getDbPool(),
    customerId,
  });
  res.json(result);
});

router.post("/shop/me/messages", requireSignedIn, async (req, res) => {
  const parsed = postBody.safeParse(req.body);
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
  const customerId = req.userCustomerId!;
  await ensureShopCustomerRow({ customerId, email: null });

  const result = await appendCustomerMessage({
    pool: getDbPool(),
    customerId,
    body: parsed.data.body,
  });

  await logAudit({
    action: "shop_customer.message.send",
    adminEmail: null,
    adminUserId: null,
    targetTable: "messages",
    targetId: result.messageId,
    metadata: {
      conversation_id: result.threadId,
      thread_created: result.threadCreated,
      // Structural only — never the body itself. Length crumb lets
      // operators spot suspiciously long pastes / spam from a single
      // customer without exposing message content.
      body_length: parsed.data.body.length,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "shop_customer.message.send audit write failed");
  });

  res.status(201).json({
    threadId: result.threadId,
    messageId: result.messageId,
    threadCreated: result.threadCreated,
  });
});

export default router;
