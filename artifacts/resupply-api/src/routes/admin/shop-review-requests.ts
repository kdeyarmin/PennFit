// /admin/shop/review-requests/send-due — manual dispatcher for the
// post-purchase review-request email.
//
// Same pattern as the abandoned-cart dispatcher: atomic claim flips
// shop_orders.review_request_sent_at from NULL to now() for every
// eligible row, then we send one email per row. Send failures
// unclaim so the next run can retry.
//
// Eligibility:
//   * status = 'paid'
//   * paid_at <= now() - 14 days  (give the customer time to actually
//     receive + use the supplies)
//   * review_request_sent_at IS NULL
//   * customer_id IS NOT NULL  (need the user to look up email +
//     comm prefs)
// Plus per-customer post-claim filters:
//   * customer's emailReviewRequests preference is true
//   * not currently in DND window
//
// Idempotency: a second invocation immediately after the first finds
// review_request_sent_at IS NOT NULL for every row we just stamped,
// so it sends nothing.
//
// Concurrency posture: the original Drizzle path used a single SQL
// `WITH eligible … FOR UPDATE SKIP LOCKED` CTE so parallel workers
// could pick up disjoint rows. PostgREST has no SKIP LOCKED, so we
// approximate with a SELECT-then-UPDATE-with-null-guard. Two parallel
// invocations of this *manual* admin endpoint will: both fetch the
// same 100 candidate ids, then both run UPDATE … WHERE id IN (…) AND
// review_request_sent_at IS NULL. Postgres serialises the UPDATEs;
// the loser sees zero rows match and simply does no work. Correctness
// is preserved, parallelism is lost — acceptable for an admin-
// triggered manual dispatcher run by humans.

import { Router, type IRouter } from "express";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
} from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { isInDndWindow } from "../../lib/comm-prefs";
import { sendReviewRequestEmail } from "../../lib/messaging/review-request-email";

const router: IRouter = Router();

const REVIEW_REQUEST_AGE_DAYS = 14;
const SCAN_LIMIT = 100;

router.post(
  "/admin/shop/review-requests/send-due",
  // Manual dispatcher for post-purchase review-request emails.
  // CSR-tier operational action (atomic-claim + comm-prefs aware) —
  // `conversations.manage` matches the rest of the customer-touch
  // operational surface.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_review_requests.send_due", preset: "bulk" }),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    const cutoffIso = new Date(
      Date.now() - REVIEW_REQUEST_AGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Step 1 — pick the eligible candidate ids. Bounded by SCAN_LIMIT
    // so a single invocation can't run away on a backlog.
    const { data: candidates, error: candidatesErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, customer_id")
      .eq("status", "paid")
      .lte("paid_at", cutoffIso)
      .is("review_request_sent_at", null)
      .not("customer_id", "is", null)
      .order("paid_at", { ascending: true })
      .limit(SCAN_LIMIT);
    if (candidatesErr) throw candidatesErr;

    const candidateIds = (candidates ?? []).map((r) => r.id);
    if (candidateIds.length === 0) {
      res.json({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        skippedOptOut: 0,
      });
      return;
    }

    // Step 2 — atomic stamp. The .is("review_request_sent_at", null)
    // guard makes this idempotent: a parallel call that already
    // stamped these rows will match zero here.
    const nowIso = new Date().toISOString();
    const { data: claimedRows, error: claimErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({ review_request_sent_at: nowIso })
      .in("id", candidateIds)
      .is("review_request_sent_at", null)
      .select("id, customer_id");
    if (claimErr) throw claimErr;

    const claimed = (claimedRows ?? []).filter(
      (r): r is { id: string; customer_id: string } => r.customer_id !== null,
    );

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
    const userIds = Array.from(new Set(claimed.map((r) => r.customer_id)));
    const { data: customerRows, error: customersErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id, email_lower, communication_preferences")
      .in("customer_id", userIds);
    if (customersErr) throw customersErr;
    const customerMap = new Map(
      (customerRows ?? []).map((r) => [
        r.customer_id,
        {
          email: r.email_lower,
          prefs: {
            ...DEFAULT_COMMUNICATION_PREFERENCES,
            ...((r.communication_preferences as CommunicationPreferences | null) ??
              {}),
          },
        },
      ]),
    );

    // For each claimed order, look up its first product so we can
    // link the customer somewhere meaningful. One query for the whole
    // batch.
    const claimedOrderIds = claimed.map((c) => c.id);
    const { data: itemRows, error: itemsErr } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .select("order_id, product_id")
      .in("order_id", claimedOrderIds);
    if (itemsErr) throw itemsErr;
    const firstProductByOrder = new Map<string, string>();
    for (const it of itemRows ?? []) {
      // First (oldest) line item per order wins. We don't bother
      // sorting since we just need any product to link to.
      if (!firstProductByOrder.has(it.order_id)) {
        firstProductByOrder.set(it.order_id, it.product_id);
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

    const unclaim = async (id: string): Promise<void> => {
      const { error: unclaimErr } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .update({ review_request_sent_at: null })
        .eq("id", id);
      if (unclaimErr) {
        req.log?.warn(
          { err: unclaimErr, orderId: id },
          "review-request unclaim failed",
        );
      }
    };

    for (const row of claimed) {
      const cust = customerMap.get(row.customer_id);
      const prefs = cust?.prefs ?? { ...DEFAULT_COMMUNICATION_PREFERENCES };
      const email = cust?.email ?? null;

      // Comm-prefs gate.
      if (!prefs.emailReviewRequests || isInDndWindow(prefs)) {
        await unclaim(row.id);
        skippedOptOut += 1;
        continue;
      }

      if (!email) {
        await unclaim(row.id);
        skippedFailed += 1;
        continue;
      }

      const productId = firstProductByOrder.get(row.id);
      if (!productId) {
        // No items somehow (defensive — shouldn't happen for paid
        // orders). Unclaim and skip.
        await unclaim(row.id);
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
        await unclaim(row.id);
        skippedNoConfig += 1;
      } else {
        await unclaim(row.id);
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
