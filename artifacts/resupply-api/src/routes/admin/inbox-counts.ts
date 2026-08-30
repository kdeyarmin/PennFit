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
//   * newInboundFaxes / pendingFitReviews / newFitRequests /
//     openFitterFollowups / pacwareReadyToSync — later additions, each
//     documented at its probe below. The fitter pair matters most for
//     lead capture: the mask fitter ends in a request a person works,
//     and the email that announces one is fail-soft — the badge is the
//     signal that cannot silently not arrive.
//
// Every count is a cheap index-backed head query, run in parallel, to
// keep the endpoint cheap for a query that fires on every admin nav
// render.
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

import { getOrgScopedClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/inbox-counts",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();

    // Read the auto-sync toggle first so we only run the (potentially
    // expensive) episodes count when the operator has opted in. Fail-soft
    // to "off" so a config-read hiccup zeroes one badge instead of
    // 500ing them all.
    let pacwareAutoSync = false;
    const { data: autoSyncRow, error: autoSyncErr } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "pacware.auto_sync")
      .limit(1)
      .maybeSingle();
    if (!autoSyncErr) {
      pacwareAutoSync =
        (autoSyncRow as { value?: string } | null)?.value === "true";
    }

    // Ten counts in parallel. Each individual query is already
    // index-backed (every WHERE clause hits a partial or narrow index),
    // so the wall-clock cost is the slowest of the ten rather than
    // their sum.
    // Throw on ANY of the ten errors so a partial Supabase failure
    // surfaces as a 500 rather than silently rendering "queue empty"
    // on every nav badge. The previous code destructured only `count`
    // from each result and ignored `error`, which masked transient
    // table-permission / network-blip errors as zero counts.
    const results = await Promise.all([
      supabase
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("status", "awaiting_admin"),
      supabase
        .from("shop_returns")
        .select("*", { count: "exact", head: true })
        // Admin-blocking states only (see module doc): `requested` (await
        // approve/reject), `shipped_back` (await receive), `received`
        // (await refund/replace). `approved` is waiting on the CUSTOMER to
        // ship the item back, so it must not inflate the CSR badge.
        .in("status", ["requested", "shipped_back", "received"]),
      supabase
        .from("shop_reviews")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("patient_documents")
        .select("*", { count: "exact", head: true })
        .is("reviewed_at", null),
      supabase
        .from("shop_customer_followups")
        .select("*", { count: "exact", head: true })
        .is("completed_at", null)
        .lt("due_at", nowIso),
      supabase
        .from("patient_followups")
        .select("*", { count: "exact", head: true })
        .is("completed_at", null)
        .lt("due_at", nowIso),
      supabase
        .from("inbound_faxes")
        .select("*", { count: "exact", head: true })
        .eq("status", "new"),
      // Fittings waiting on a clinician. Backed by
      // fit_sessions_org_review_idx (org_id, review_status, created_at) —
      // without this badge a pending fitting sat silently until someone
      // happened to open the review queue.
      supabase
        .from("fit_sessions")
        .select("*", { count: "exact", head: true })
        .eq("review_status", "pending_review"),
      // Fit requests nobody has picked up — the queue the mask fitter now
      // ends in, and a promise-shaped one (the confirmation email tells
      // the patient "within one business day"). The staff notification
      // email for a new request is deliberately fail-soft, so without
      // this badge a lead whose email never arrived sat invisible until
      // someone happened to open /admin/fitter-requests. Backed by
      // fitter_fit_requests_org_status_created_idx (migration 0518).
      supabase
        .from("fitter_fit_requests")
        .select("*", { count: "exact", head: true })
        .eq("status", "new"),
      // Fitter follow-up alerts still open — who went quiet after a
      // fitter link went out (never opened, abandoned mid-fitting,
      // finished but never asked, or asked and sat unworked). The sweep
      // only ever writes rows; nothing pushes them at staff, so the
      // badge is what makes the worklist self-announcing. Backed by
      // fitter_followup_alerts_org_status_idx (migration 0536).
      supabase
        .from("fitter_followup_alerts")
        .select("*", { count: "exact", head: true })
        .eq("status", "open"),
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
      { count: pendingFitReviews },
      { count: newFitRequests },
      { count: openFitterFollowups },
    ] = results;

    // Only query the episodes count when the operator has opted into
    // auto-sync notices (the pacware.auto_sync toggle above). Fail-soft
    // to 0 so an optional-feature hiccup doesn't 500 the other badges.
    let pacwareConfirmed = 0;
    if (pacwareAutoSync) {
      const { count, error: episodesErr } = await supabase
        .from("episodes")
        .select("id, prescriptions!inner(id), patients!inner(id)", {
          count: "exact",
          head: true,
        })
        .eq("status", "confirmed");
      if (!episodesErr) {
        pacwareConfirmed = count ?? 0;
      }
    }

    res.json({
      awaitingReplyConversations: awaitingReplyConversations ?? 0,
      pendingReturns: pendingReturns ?? 0,
      pendingReviews: pendingReviews ?? 0,
      overdueFollowups: (overdueShop ?? 0) + (overduePatient ?? 0),
      newPatientDocuments: newPatientDocuments ?? 0,
      newInboundFaxes: newInboundFaxes ?? 0,
      pendingFitReviews: pendingFitReviews ?? 0,
      newFitRequests: newFitRequests ?? 0,
      openFitterFollowups: openFitterFollowups ?? 0,
      pacwareReadyToSync: pacwareConfirmed,
      serverTime: new Date().toISOString(),
    });
  },
);

export default router;
