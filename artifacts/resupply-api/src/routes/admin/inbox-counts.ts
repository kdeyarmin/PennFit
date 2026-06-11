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

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/inbox-counts",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();

    // Six counts in parallel. The original code packed four into one
    // round-trip via `SELECT (subquery), (subquery), …` for a single
    // payload; PostgREST doesn't expose that shape, so we issue six
    // and parallelize via Promise.all. Each individual query is
    // already index-backed (every WHERE clause hits a partial or
    // narrow index), so the wall-clock cost is the slowest of the
    // six rather than their sum.
    // Throw on ANY of the seven errors so a partial Supabase failure
    // surfaces as a 500 rather than silently rendering "queue empty"
    // on every nav badge. The previous code destructured only `count`
    // from each result and ignored `error`, which masked transient
    // table-permission / network-blip errors as zero counts.
    const results = await Promise.all([
      supabase
        .schema("resupply")
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("status", "awaiting_admin"),
      supabase
        .schema("resupply")
        .from("shop_returns")
        .select("*", { count: "exact", head: true })
        // Admin-blocking states only (see module doc): `requested` (await
        // approve/reject), `shipped_back` (await receive), `received`
        // (await refund/replace). `approved` is waiting on the CUSTOMER to
        // ship the item back, so it must not inflate the CSR badge.
        .in("status", ["requested", "shipped_back", "received"]),
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
      supabase
        .schema("resupply")
        .from("inbound_faxes")
        .select("*", { count: "exact", head: true })
        .eq("status", "new"),
      // Confirmed resupply episodes waiting on a PacWare CSV export —
      // same definition as the /admin/pacware "ready to sync" banner.
      // Surfaced as a badge only when the operator has opted into
      // auto-sync notices (the pacware.auto_sync app_config toggle,
      // read below), so an operator who runs exports on their own
      // schedule isn't nagged by a perpetual badge.
      supabase
        .schema("resupply")
        .from("episodes")
        .select("id, prescriptions!inner(id), patients!inner(id)", {
          count: "exact",
          head: true,
        })
        .eq("status", "confirmed"),
    ]);
    for (const r of results) {
      if (r.error) throw r.error;
    }
    const [
      { count: awaitingReplyConversations },
      { count: pendingReturns },
      { count: pendingReviews },
      { count: newPatientDocuments },
      { count: overdueShop },
      { count: overduePatient },
      { count: newInboundFaxes },
      { count: pacwareConfirmed },
    ] = results;

    // The auto-sync opt-in lives in app_config as a plain row (see
    // routes/admin/pacware.ts AUTO_SYNC_KEY). Fail-soft to "off" so a
    // config-read hiccup zeroes one badge instead of 500ing them all.
    let pacwareAutoSync = false;
    const { data: autoSyncRow, error: autoSyncErr } = await supabase
      .schema("resupply")
      .from("app_config")
      .select("value")
      .eq("key", "pacware.auto_sync")
      .limit(1)
      .maybeSingle();
    if (!autoSyncErr) {
      pacwareAutoSync =
        (autoSyncRow as { value?: string } | null)?.value === "true";
    }

    res.json({
      awaitingReplyConversations: awaitingReplyConversations ?? 0,
      pendingReturns: pendingReturns ?? 0,
      pendingReviews: pendingReviews ?? 0,
      overdueFollowups: (overdueShop ?? 0) + (overduePatient ?? 0),
      newPatientDocuments: newPatientDocuments ?? 0,
      newInboundFaxes: newInboundFaxes ?? 0,
      pacwareReadyToSync: pacwareAutoSync ? (pacwareConfirmed ?? 0) : 0,
      serverTime: new Date().toISOString(),
    });
  },
);

export default router;
