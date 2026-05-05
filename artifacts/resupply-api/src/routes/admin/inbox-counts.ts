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
//   * overdueFollowups — open shop_customer_followups OR
//     patient_followups whose due_at is in the past (Phase 18 + 20).
//   * newPatientDocuments — patient_documents uploaded by patients
//     that no admin has yet marked as reviewed (reviewed_at IS NULL).
//     Drives the badge on the Patients nav link so CSRs know when
//     something new needs their attention.
//
// All five counts (four scalar subqueries + overdue-followup pair) land
// in three db round-trips to keep the endpoint cheap for a query that
// fires on every admin nav render.
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

import {
  getDbPool,
  patientFollowups,
  shopCustomerFollowups,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

interface CountsRow {
  awaiting_reply_conversations: number;
  pending_returns: number;
  pending_reviews: number;
  new_patient_documents: number;
}

router.get("/admin/inbox-counts", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());

  // Single round-trip: four scalar subqueries in one SELECT.
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM conversations
        WHERE status = 'awaiting_admin') AS awaiting_reply_conversations,
      (SELECT count(*)::int FROM shop_returns
        WHERE status IN ('requested','approved','shipped_back','received')) AS pending_returns,
      (SELECT count(*)::int FROM shop_reviews
        WHERE status = 'pending') AS pending_reviews,
      (SELECT count(*)::int FROM resupply.patient_documents
        WHERE reviewed_at IS NULL) AS new_patient_documents
  `);

  const row = result.rows[0] as unknown as CountsRow | undefined;

  // Overdue followups across BOTH shop_customer and patient surfaces.
  // Each side uses its own partial index (open AND due) so the count
  // scales with the open queue, not the full history. Sum in JS.
  const [[overdueShopRow], [overduePatientRow]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(shopCustomerFollowups)
      .where(
        sql`${shopCustomerFollowups.completedAt} IS NULL AND ${shopCustomerFollowups.dueAt} < now()`,
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(patientFollowups)
      .where(
        sql`${patientFollowups.completedAt} IS NULL AND ${patientFollowups.dueAt} < now()`,
      ),
  ]);

  res.json({
    awaitingReplyConversations: row?.awaiting_reply_conversations ?? 0,
    pendingReturns: row?.pending_returns ?? 0,
    pendingReviews: row?.pending_reviews ?? 0,
    overdueFollowups:
      (overdueShopRow?.count ?? 0) + (overduePatientRow?.count ?? 0),
    newPatientDocuments: row?.new_patient_documents ?? 0,
    serverTime: new Date().toISOString(),
  });
});

export default router;
