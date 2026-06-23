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
// Concurrency posture: the original SQL path used a single
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

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { runReviewRequestDispatch } from "../../lib/review-requests/run-dispatch";

const router: IRouter = Router();

router.post(
  "/admin/shop/review-requests/send-due",
  // Manual dispatcher for post-purchase review-request emails. The
  // hourly review-request cron runs the SAME shared dispatcher.
  // CSR-tier operational action — `conversations.manage` matches the
  // rest of the customer-touch operational surface.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_review_requests.send_due", preset: "bulk" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const stats = await runReviewRequestDispatch({ orgId, log: req.log });
    res.json(stats);
  },
);

export default router;
