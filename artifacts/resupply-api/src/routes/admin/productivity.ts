// /admin/productivity — per-agent CSR throughput dashboard for
// supervisors. Surfaces "who's handling work" so a supervisor can
// reassign queues without having to crawl every table by hand.
//
//   GET /admin/productivity?window=today|7d|30d
//
// Signals (per agent, scoped to the window):
//   * Open conversations currently ASSIGNED to them (counts the
//     queue depth right now — independent of the window).
//   * Conversations they CLOSED in the window (proxy: status='closed'
//     AND last assignee == this agent AND updated_at in window).
//     Conversations don't carry a `closed_by_user_id`, so this is a
//     best-effort signal — the UI labels it as such.
//   * Returns they approved / rejected in the window
//     (shop_returns.admin_user_id + approved_at / rejected_at).
//   * Compliance alerts they resolved in the window
//     (csr_compliance_alerts.resolved_by_user_id + resolved_at).
//   * Followups they completed in the window
//     (patient_followups.completed_by_user_id + completed_at).
//
// Permission: `reports.read` (admin / supervisor / csr /
// compliance_officer per the rbac catalog). CSRs see the dashboard
// too — it's their own scorecard.
//
// Audit posture: a per-call audit row is overkill (this is a
// read-only summary that supervisors hit dozens of times per shift).
// We log only structurally to the application logger.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowQuery = z.object({
  window: z.enum(["today", "7d", "30d"]).optional(),
});

type Window = "today" | "7d" | "30d";

/** Resolve a window string to {from, to} ISO timestamps. */
function windowBounds(w: Window): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  if (w === "today") {
    from.setUTCHours(0, 0, 0, 0);
  } else if (w === "7d") {
    from.setUTCDate(from.getUTCDate() - 7);
  } else {
    from.setUTCDate(from.getUTCDate() - 30);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

interface AgentStats {
  adminUserId: string;
  email: string;
  displayName: string | null;
  role: string;
  assignedConversationsOpen: number;
  conversationsClosedInWindow: number;
  returnsApproved: number;
  returnsRejected: number;
  complianceAlertsResolved: number;
  followupsCompleted: number;
}

router.get(
  "/admin/productivity",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const win: Window = parsed.data.window ?? "7d";
    const { from, to } = windowBounds(win);

    const supabase = getSupabaseServiceRoleClient();

    // Pull the active admin roster up front. We attribute against
    // active members only — including `pending` or `revoked` would
    // confuse a supervisor reviewing "who's actually carrying load
    // right now."
    const { data: admins, error: adminsErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, email_lower, display_name, role")
      .eq("status", "active");
    if (adminsErr) throw adminsErr;
    const adminList = admins ?? [];
    if (adminList.length === 0) {
      res.json({ window: { kind: win, from, to }, agents: [] });
      return;
    }
    const adminIds = adminList.map((a) => a.id);

    // Fan out the count queries in parallel. Each returns a {id,
    // count} pair that we fold into the per-agent stats below.
    const [
      assignedOpen,
      closedInWindow,
      returnsApproved,
      returnsRejected,
      alertsResolved,
      followupsCompleted,
    ] = await Promise.all([
      groupedCount(supabase, "conversations", "assigned_admin_user_id", adminIds, (q) =>
        q.in("status", ["open", "awaiting_admin", "awaiting_patient"]),
      ),
      groupedCount(supabase, "conversations", "assigned_admin_user_id", adminIds, (q) =>
        q
          .eq("status", "closed")
          .gte("updated_at", from)
          .lte("updated_at", to),
      ),
      groupedCount(supabase, "shop_returns", "admin_user_id", adminIds, (q) =>
        q.gte("approved_at", from).lte("approved_at", to),
      ),
      groupedCount(supabase, "shop_returns", "admin_user_id", adminIds, (q) =>
        q.gte("rejected_at", from).lte("rejected_at", to),
      ),
      groupedCount(
        supabase,
        "csr_compliance_alerts",
        "resolved_by_user_id",
        adminIds,
        (q) =>
          q
            .eq("status", "resolved")
            .gte("resolved_at", from)
            .lte("resolved_at", to),
      ),
      groupedCount(
        supabase,
        "patient_followups",
        "completed_by_user_id",
        adminIds,
        (q) =>
          q
            .not("completed_at", "is", null)
            .gte("completed_at", from)
            .lte("completed_at", to),
      ),
    ]);

    const agents: AgentStats[] = adminList.map((a) => ({
      adminUserId: a.id,
      email: a.email_lower,
      displayName: a.display_name,
      role: a.role,
      assignedConversationsOpen: assignedOpen.get(a.id) ?? 0,
      conversationsClosedInWindow: closedInWindow.get(a.id) ?? 0,
      returnsApproved: returnsApproved.get(a.id) ?? 0,
      returnsRejected: returnsRejected.get(a.id) ?? 0,
      complianceAlertsResolved: alertsResolved.get(a.id) ?? 0,
      followupsCompleted: followupsCompleted.get(a.id) ?? 0,
    }));

    // Sort by "total throughput in window" so the busiest agents
    // surface at the top. Stable secondary sort by displayName so
    // alphabetic order breaks ties.
    agents.sort((a, b) => {
      const ta =
        a.conversationsClosedInWindow +
        a.returnsApproved +
        a.returnsRejected +
        a.complianceAlertsResolved +
        a.followupsCompleted;
      const tb =
        b.conversationsClosedInWindow +
        b.returnsApproved +
        b.returnsRejected +
        b.complianceAlertsResolved +
        b.followupsCompleted;
      if (ta !== tb) return tb - ta;
      return (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email);
    });

    logger.info(
      {
        event: "admin.productivity.served",
        window: win,
        agentCount: agents.length,
      },
      "admin productivity dashboard served",
    );

    res.json({
      window: { kind: win, from, to },
      agents,
    });
  },
);

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * Count rows per attribution column across a set of admin ids.
 *
 * Rather than running one head-count query per (admin × signal),
 * which would be O(N×6) round trips with N admins, we pull the
 * row ids in one shot and tally client-side. The signal counts
 * are bounded (a few hundred per window for a typical DME) so the
 * fetch + Map.set scan is comfortable.
 */
async function groupedCount(
  supabase: SupabaseClient,
  table:
    | "conversations"
    | "shop_returns"
    | "csr_compliance_alerts"
    | "patient_followups",
  attributionCol:
    | "assigned_admin_user_id"
    | "admin_user_id"
    | "resolved_by_user_id"
    | "completed_by_user_id",
  adminIds: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgrestFilterBuilder<...> generics over the table union are too deep to spell out here without a TS2589 "type instantiation is excessively deep" error.
  refine: (q: any) => unknown,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (adminIds.length === 0) return counts;

  const base = supabase.schema("resupply").from(table).select(attributionCol);
  const refined = refine(base.in(attributionCol, adminIds)) as typeof base;
  // Cap defensively. The signals we count are events, not the full
  // tables — even a busy CSR's 30-day window of follow-ups is in the
  // low hundreds.
  const { data, error } = await refined.limit(50_000);
  if (error) throw error;
  // Cast through unknown: PostgREST infers a union of per-table
  // row types here, but every variant carries the attribution
  // column we selected — the runtime shape is uniform.
  for (const row of (data ?? []) as unknown as Array<
    Record<string, string | null>
  >) {
    const id = row[attributionCol];
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export default router;
