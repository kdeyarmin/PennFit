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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import {
  IN_APP_MESSAGE_BODY_MAX,
  appendCustomerMessage,
  fetchInAppThread,
  fetchInAppUnreadCount,
  markInAppThreadRead,
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
    supabase: getSupabaseServiceRoleClient(),
    customerId,
  });
  res.json(result);
});

// Cheap polling endpoint behind the header badge. Returns just the
// count of unread CSR messages — the heavy thread fetch only happens
// when the customer actually opens /account.
router.get(
  "/shop/me/messages/unread-count",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId!;
    await ensureShopCustomerRow({ customerId, email: null });
    const count = await fetchInAppUnreadCount({
      supabase: getSupabaseServiceRoleClient(),
      customerId,
    });
    res.json({ unreadFromCsr: count });
  },
);

// Mark the customer's in-app thread fully read. Idempotent — the
// AccountMessagesSection calls this on every render so the badge
// disappears even if the customer keeps the page open while the CSR
// keeps replying. Returns 200 even when the customer has no thread
// yet (no-op).
router.post(
  "/shop/me/messages/mark-read",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId!;
    await ensureShopCustomerRow({ customerId, email: null });
    const updated = await markInAppThreadRead({
      supabase: getSupabaseServiceRoleClient(),
      customerId,
    });
    res.json({ ok: true, threadUpdated: updated });
  },
);

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
    supabase: getSupabaseServiceRoleClient(),
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

  // Best-effort notification email to the shared CSR inbox so a CSR
  // sees the ping without polling /admin/conversations. Subject-only,
  // never the message body, so the email provider stays PHI-free
  // even though the body is plaintext in the DB. Disabled by leaving
  // SHOP_CSR_INBOX_EMAIL unset — preview/dev environments don't need
  // SendGrid configured.
  await tryNotifyCsrInbox({
    threadId: result.threadId,
    threadCreated: result.threadCreated,
    customerEmail: req.shopCustomerEmail ?? null,
    customerDisplayName: req.shopCustomerDisplayName ?? null,
  }).catch((err) => {
    logger.warn(
      { err, conversation_id: result.threadId },
      "shop_customer.message.send: CSR-inbox notification failed (the message is in the DB regardless)",
    );
  });

  res.status(201).json({
    threadId: result.threadId,
    messageId: result.messageId,
    threadCreated: result.threadCreated,
  });
});

/**
 * Notify the shared CSR inbox when a customer posts. Best-effort —
 * a SendGrid outage doesn't reach the route handler. The notification
 * is subject-only (no body) so even though the body is plaintext in
 * the DB, the email provider never sees PHI.
 *
 * Skips silently when:
 *   * `SHOP_CSR_INBOX_EMAIL` is unset (operator opt-out)
 *   * `SENDGRID_API_KEY` etc. are unset (preview / dev)
 */
async function tryNotifyCsrInbox(input: {
  threadId: string;
  threadCreated: boolean;
  customerEmail: string | null;
  customerDisplayName: string | null;
}): Promise<void> {
  const inboxEmail = process.env["SHOP_CSR_INBOX_EMAIL"]?.trim();
  if (!inboxEmail) {
    return;
  }

  let sg;
  try {
    sg = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Preview / dev — no SENDGRID_API_KEY. Skip silently.
      return;
    }
    throw err;
  }

  // Subject + body are deliberately content-free. We surface the
  // customer's display name (or email) so the CSR knows who pinged
  // — display name is already visible in the admin inbox header,
  // not new PHI surface.
  const customerLabel =
    input.customerDisplayName ?? input.customerEmail ?? "A shop customer";
  const subjectPrefix = input.threadCreated ? "New" : "Reply on";
  const subject = `${subjectPrefix} customer message — ${customerLabel}`;

  // Pull the public base URL from the same env the rest of the
  // shop side uses. Fallback to relative path so the link still
  // navigates if the env var isn't set in dev.
  const base = process.env["SHOP_PUBLIC_BASE_URL"]?.trim().replace(/\/$/, "");
  const inboxUrl = `${base ?? ""}/admin/conversations/${input.threadId}`;

  await sg.sendEmail({
    to: inboxEmail,
    subject,
    text:
      `A signed-in shop customer just messaged customer service.\n\n` +
      `Open the thread:\n${inboxUrl}\n\n` +
      `(This email contains no message content. Sign in to read.)\n`,
    html:
      `<p>A signed-in shop customer just messaged customer service.</p>` +
      `<p><a href="${inboxUrl}" style="color: #003B71">Open the thread →</a></p>` +
      `<p style="color: #6b7280; font-size: 12px">` +
      `This email contains no message content. Sign in to read.` +
      `</p>`,
    customArgs: {
      conversation_id: input.threadId,
      kind: "in_app_csr_inbox_ping",
    },
  });
}

export default router;
