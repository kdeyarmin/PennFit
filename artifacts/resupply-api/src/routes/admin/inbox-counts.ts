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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/inbox-counts", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Six counts in parallel. The original code packed four into one
  // round-trip via `SELECT (subquery), (subquery), …` for a single
  // payload; PostgREST doesn't expose that shape, so we issue six
  // and parallelize via Promise.all. Each individual query is
  // already index-backed (every WHERE clause hits a partial or
  // narrow index), so the wall-clock cost is the slowest of the
  // six rather than their sum.
  const [
    { count: awaitingReplyConversations },
    { count: pendingReturns },
    { count: pendingReviews },
    { count: newPatientDocuments },
    { count: overdueShop },
    { count: overduePatient },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "awaiting_admin"),
    supabase
      .schema("resupply")
      .from("shop_returns")
      .select("*", { count: "exact", head: true })
      .in("status", ["requested", "approved", "shipped_back", "received"]),
    supabase
      .schema("resupply")
      .from("shop_reviews")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .schema("resupply")
      .from("patient_documents")
      .select("*", { count: "exact", head: true })
      .is("reviewed_at", null),
    supabase
      .schema("resupply")
      .from("shop_customer_followups")
      .select("*", { count: "exact", head: true })
      .is("completed_at", null)
      .lt("due_at", nowIso),
    supabase
      .schema("resupply")
      .from("patient_followups")
      .select("*", { count: "exact", head: true })
      .is("completed_at", null)
      .lt("due_at", nowIso),
  ]);

  res.json({
    awaitingReplyConversations: awaitingReplyConversations ?? 0,
    pendingReturns: pendingReturns ?? 0,
    pendingReviews: pendingReviews ?? 0,
    overdueFollowups: (overdueShop ?? 0) + (overduePatient ?? 0),
    newPatientDocuments: newPatientDocuments ?? 0,
    serverTime: new Date().toISOString(),
  });
});

export default router;
