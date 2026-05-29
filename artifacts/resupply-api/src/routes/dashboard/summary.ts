// GET /dashboard/summary — top-of-page admin counters.
//
// Five COUNT(*) queries over the resupply.* tables. No PHI in the
// response — every value is a row count. Run as separate queries
// rather than one giant UNION because (a) it's clearer, (b) the
// table-level indexes already make each one cheap, and (c) each one
// can fail independently and the admin gets a 500 with a clean
// log message rather than a partially-populated dashboard.
//
// We do NOT write an audit row for this endpoint: the response
// contains no PHI and no row identifiers, so there is nothing to
// audit beyond "the admin opened the dashboard" — covered by
// the existing /me audit on session bootstrap.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { getLatestPhiSweepStatus } from "./sweep-status";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const nowIso = new Date().toISOString();

  const [
    { count: activeConversations },
    { count: awaitingAdmin },
    { count: overdueEpisodes },
    { count: fulfillmentsThisWeek },
    { count: pausedPatients },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .in("status", ["open", "awaiting_patient", "awaiting_admin"]),
    supabase
      .schema("resupply")
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "awaiting_admin"),
    supabase
      .schema("resupply")
      .from("episodes")
      .select("*", { count: "exact", head: true })
      .in("status", ["outreach_pending", "awaiting_response"])
      .lte("due_at", nowIso),
    supabase
      .schema("resupply")
      .from("fulfillments")
      .select("*", { count: "exact", head: true })
      .gte("created_at", sevenDaysAgo),
    supabase
      .schema("resupply")
      .from("patients")
      .select("*", { count: "exact", head: true })
      .eq("status", "paused"),
  ]);

  // Latest PHI sweep status — read-only projection over the
  // most recent `prescription.attachment.sweep` audit row. Defensive:
  // helper returns null on no-row-yet OR malformed metadata; we
  // never let it 500 the dashboard.
  const prescriptionAttachmentSweep = await getLatestPhiSweepStatus();

  res.status(200).json({
    activeConversations: activeConversations ?? 0,
    awaitingAdmin: awaitingAdmin ?? 0,
    overdueEpisodes: overdueEpisodes ?? 0,
    fulfillmentsThisWeek: fulfillmentsThisWeek ?? 0,
    pausedPatients: pausedPatients ?? 0,
    prescriptionAttachmentSweep,
  });
});

export default router;
