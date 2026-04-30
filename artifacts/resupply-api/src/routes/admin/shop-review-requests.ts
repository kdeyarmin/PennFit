// /admin/shop/review-requests/send-due — manual dispatcher for the
// post-purchase review-request email.
//
// Same pattern as the abandoned-cart dispatcher: atomic claim
// (UPDATE … RETURNING) on shop_orders flips review_request_sent_at
// from NULL to now() for every eligible row, then we send one email
// per row. Send failures unclaim so the next run can retry.
//
// Eligibility:
//   * status = 'paid'
//   * paid_at <= now() - 14 days  (give the customer time to actually
//     receive + use the supplies)
//   * review_request_sent_at IS NULL
//   * clerk_user_id IS NOT NULL  (need the user to look up email +
//     comm prefs)
// Plus per-customer post-claim filters:
//   * customer's emailReviewRequests preference is true
//   * not currently in DND window
//
// Idempotency: a second invocation immediately after the first finds
// review_request_sent_at IS NOT NULL for every row we just stamped,
// so it sends nothing.

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { clerkClient } from "@clerk/express";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getDbPool,
  shopCustomers,
  shopOrders,
  shopOrderItems,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { isInDndWindow } from "../../lib/comm-prefs";
import { sendReviewRequestEmail } from "../../lib/messaging/review-request-email";

const router: IRouter = Router();

const REVIEW_REQUEST_AGE_DAYS = 14;
const SCAN_LIMIT = 100;

router.post(
  "/admin/shop/review-requests/send-due",
  requireAdmin,
  async (req, res) => {
    const db = drizzle(getDbPool());

    // Atomic claim. Same pattern as the abandoned-cart dispatcher.
    const claimedRaw = await db.execute(sql`
      WITH eligible AS (
        SELECT id
        FROM ${shopOrders}
        WHERE ${shopOrders.status} = 'paid'
          AND ${shopOrders.paidAt} <= now() - (${REVIEW_REQUEST_AGE_DAYS} || ' days')::interval
          AND ${shopOrders.reviewRequestSentAt} IS NULL
          AND ${shopOrders.clerkUserId} IS NOT NULL
        ORDER BY ${shopOrders.paidAt} ASC
        LIMIT ${SCAN_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${shopOrders}
      SET review_request_sent_at = now()
      WHERE id IN (SELECT id FROM eligible)
      RETURNING id, clerk_user_id AS "clerkUserId"
    `);
    const claimed = (claimedRaw.rows ?? []) as Array<{
      id: string;
      clerkUserId: string;
    }>;

    if (claimed.length === 0) {
      res.json({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        skippedOptOut: 0,
      });
      return;
    }

    // Batch-fetch comm prefs for every claimed user.
    const userIds = Array.from(new Set(claimed.map((r) => r.clerkUserId)));
    const customerRows = await db
      .select({
        clerkUserId: shopCustomers.clerkUserId,
        email: shopCustomers.emailLower,
        prefs: shopCustomers.communicationPreferences,
      })
      .from(shopCustomers)
      .where(sql`${shopCustomers.clerkUserId} = ANY(${userIds})`);
    const customerMap = new Map(
      customerRows.map((r) => [
        r.clerkUserId,
        {
          email: r.email,
          prefs: { ...DEFAULT_COMMUNICATION_PREFERENCES, ...(r.prefs ?? {}) },
        },
      ]),
    );

    // For each claimed order, look up its first product so we can
    // link the customer somewhere meaningful. One query for the whole
    // batch.
    const itemRows = await db
      .select({
        orderId: shopOrderItems.orderId,
        productId: shopOrderItems.productId,
        paidAt: shopOrderItems.paidAt,
      })
      .from(shopOrderItems)
      .where(
        sql`${shopOrderItems.orderId} = ANY(${claimed.map((c) => c.id)})`,
      );
    const firstProductByOrder = new Map<string, string>();
    for (const it of itemRows) {
      // First (oldest) line item per order wins. We don't bother
      // sorting since we just need any product to link to.
      if (!firstProductByOrder.has(it.orderId)) {
        firstProductByOrder.set(it.orderId, it.productId);
      }
    }

    let sent = 0;
    let skippedNoConfig = 0;
    let skippedFailed = 0;
    let skippedOptOut = 0;

    const baseUrl =
      process.env.SHOP_PUBLIC_BASE_URL ??
      process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      "https://pennpaps.com";

    for (const row of claimed) {
      const cust = customerMap.get(row.clerkUserId);
      const prefs = cust?.prefs ?? { ...DEFAULT_COMMUNICATION_PREFERENCES };
      let email = cust?.email ?? null;

      // Comm-prefs gate.
      if (!prefs.emailReviewRequests || isInDndWindow(prefs)) {
        await db
          .update(shopOrders)
          .set({ reviewRequestSentAt: null })
          .where(eq(shopOrders.id, row.id));
        skippedOptOut += 1;
        continue;
      }

      // If we don't have an email cached, look it up from Clerk.
      if (!email) {
        try {
          const user = await clerkClient.users.getUser(row.clerkUserId);
          const primary =
            user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
            user.emailAddresses[0];
          email = primary?.emailAddress?.toLowerCase() ?? null;
        } catch {
          email = null;
        }
      }
      if (!email) {
        await db
          .update(shopOrders)
          .set({ reviewRequestSentAt: null })
          .where(eq(shopOrders.id, row.id));
        skippedFailed += 1;
        continue;
      }

      const productId = firstProductByOrder.get(row.id);
      if (!productId) {
        // No items somehow (defensive — shouldn't happen for paid
        // orders). Unclaim and skip.
        await db
          .update(shopOrders)
          .set({ reviewRequestSentAt: null })
          .where(eq(shopOrders.id, row.id));
        skippedFailed += 1;
        continue;
      }

      const productUrl = `${baseUrl}/shop/p/${encodeURIComponent(productId)}?utm_source=email&utm_medium=transactional&utm_campaign=review_request`;
      const productName = `your last order`; // generic — we don't have catalog name in this scope, and the email reads naturally either way

      const result = await sendReviewRequestEmail({
        to: email,
        productName,
        productUrl,
      });

      if (result.sent) {
        sent += 1;
      } else if (result.reason === "email_not_configured") {
        await db
          .update(shopOrders)
          .set({ reviewRequestSentAt: null })
          .where(eq(shopOrders.id, row.id));
        skippedNoConfig += 1;
      } else {
        await db
          .update(shopOrders)
          .set({ reviewRequestSentAt: null })
          .where(eq(shopOrders.id, row.id));
        skippedFailed += 1;
        req.log?.warn(
          { orderId: row.id, reason: result.reason },
          "review-request send failed",
        );
      }
    }

    res.json({
      scanned: claimed.length,
      sent,
      skippedNoConfig,
      skippedFailed,
      skippedOptOut,
    });
  },
);

export default router;
