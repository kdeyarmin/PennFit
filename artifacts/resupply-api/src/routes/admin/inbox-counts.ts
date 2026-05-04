// /admin/inbox-counts — actionable-work counters surfaced as nav
// badges in the admin SPA (Phase 16).
//
// One round-trip returns:
//   * awaitingReplyConversations — in_app threads where the customer
//     has posted and a CSR owes them a reply (status = awaiting_admin).
//   * pendingReturns — shop_returns in lifecycle states that block on
//     admin action (`requested` waiting for approve/reject;
//     `shipped_back` waiting for receive).
//   * pendingReviews — customer-submitted product reviews awaiting
//     moderation (status = pending).
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
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  getDbPool,
  shopReturns,
  shopReviews,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/inbox-counts", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());

  const [awaitingReplyRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      sql`${conversations.channel} = 'in_app' AND ${conversations.status} = 'awaiting_admin'`,
    );

  const [pendingReturnsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopReturns)
    .where(sql`${shopReturns.status} IN ('requested','shipped_back')`);

  const [pendingReviewsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopReviews)
    .where(eq(shopReviews.status, "pending"));

  res.json({
    awaitingReplyConversations: awaitingReplyRow?.count ?? 0,
    pendingReturns: pendingReturnsRow?.count ?? 0,
    pendingReviews: pendingReviewsRow?.count ?? 0,
    serverTime: new Date().toISOString(),
  });
});

export default router;
