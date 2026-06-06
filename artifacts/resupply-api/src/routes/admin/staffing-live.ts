// GET /admin/staffing/live — real-time CSR workload snapshot (CSR #C3).
//
// The companion to /admin/productivity (which is a lagging close-rate
// rollup): this is the LIVE picture a supervisor uses to rebalance work
// mid-shift — open conversation load per active agent, who's on shift,
// availability, and the unassigned backlog. Read-only; the per-agent
// counting + sorting lives in the pure buildLiveStaffing().
//
// Permission: reports.read (same as /admin/productivity).

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";
import { buildLiveStaffing } from "../../lib/staffing/build-live-staffing";

const OPEN_CONVERSATION_STATUSES = [
  "open",
  "awaiting_admin",
  "awaiting_patient",
];

const router: IRouter = Router();

router.get(
  "/admin/staffing/live",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Active staff roster + their current availability.
    const { data: admins, error: adminsErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("id, email_lower, display_name, role, availability")
      .eq("status", "active");
    if (adminsErr) throw adminsErr;
    const agents = (admins ?? []).map((a) => ({
      id: a.id,
      email: a.email_lower,
      displayName: a.display_name,
      role: a.role,
      availability: a.availability,
    }));

    // Every OPEN conversation's assignee (null = unassigned backlog).
    // Capped for safety on very large queues.
    const { data: convos, error: convErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("assigned_admin_user_id")
      .in("status", OPEN_CONVERSATION_STATUSES)
      .limit(20000);
    if (convErr) throw convErr;
    const openConversationAssignees = (convos ?? []).map(
      (c) => c.assigned_admin_user_id ?? null,
    );

    // Who's on shift right now (started, not ended, not called off).
    const nowIso = new Date().toISOString();
    const { data: shifts, error: shiftErr } = await supabase
      .schema("resupply")
      .from("csr_shifts")
      .select("staff_user_id")
      .lte("starts_at", nowIso)
      .gt("ends_at", nowIso)
      .neq("status", "called_off")
      .limit(2000);
    if (shiftErr) throw shiftErr;
    const onShiftIds = (shifts ?? [])
      .map((s) => s.staff_user_id)
      .filter((id): id is string => Boolean(id));

    res.json(
      buildLiveStaffing({ agents, openConversationAssignees, onShiftIds }),
    );
  },
);

export default router;
