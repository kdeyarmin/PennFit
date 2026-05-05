// /admin/inbox-counts — actionable-work counters surfaced as nav
// badges in the admin SPA (Phase 16).
//
// One round-trip returns:
//   * awaitingReplyConversations — conversations across ALL channels
//     (sms, voice, email, in_app) where the customer has posted and a
//     CSR owes them a reply (status = awaiting_admin).  The
//     /admin/conversations inbox is cross-channel, so limiting to
//     in_app would silently under-report the queue.
//   * pendingReturns — shop_returns in lifecycle states that block on
//     admin action (`requested` waiting for approve/reject;
//     `shipped_back` waiting for receive; `received` waiting for
//     refund/replace resolution).
//   * pendingReviews — customer-submitted product reviews awaiting
//     moderation (status = pending).
//
// All three counts land in a single db.execute() call (one round-trip)
// to keep the endpoint as cheap as possible for a query that fires on
// every admin nav render.
//
// Pure SQL counts. No PHI. Same boot-time-safe pattern as
// /admin/ops-status — fast enough for the nav to call on every page
// load, but the SPA caches the result for ~30s anyway.
//
// Why a separate endpoint from /admin/ops-status: that endpoint is
// for the operations dashboard (vendor flags, dispatcher counts, team
// counts) and is read on demand. This one is read on every nav render,
// so we keep the surface tiny and the SQL fast.

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

interface CountsRow {
  awaiting_reply_conversations: number;
  pending_returns: number;
  pending_reviews: number;
}

router.get("/admin/inbox-counts", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());

  // Single round-trip: three scalar subqueries in one SELECT.
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM conversations
        WHERE status = 'awaiting_admin') AS awaiting_reply_conversations,
      (SELECT count(*)::int FROM shop_returns
        WHERE status IN ('requested','approved','shipped_back','received')) AS pending_returns,
      (SELECT count(*)::int FROM shop_reviews
        WHERE status = 'pending') AS pending_reviews
  `);

  const row = result.rows[0] as CountsRow | undefined;

  res.json({
    awaitingReplyConversations: row?.awaiting_reply_conversations ?? 0,
    pendingReturns: row?.pending_returns ?? 0,
    pendingReviews: row?.pending_reviews ?? 0,
    serverTime: new Date().toISOString(),
  });
});

export default router;
