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

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";
import { buildLiveStaffing } from "../../lib/staffing/build-live-staffing";

const OPEN_CONVERSATION_STATUSES = [
  "open",
  "awaiting_admin",
  "awaiting_patient",
];

/** PostgREST page size (matches max_rows default). */
const OPEN_CONVO_PAGE = 1000;
/**
 * Safety bound on how many open-conversation assignee rows we fold into
 * the live snapshot. Past this we stop and set `windowTruncated` so the
 * UI can show that the tallies are a newest-first window, not a silent
 * partial unordered slice (the old bare `.limit(20000)` trap).
 */
const OPEN_CONVO_MAX_ROWS = 20000;

const router: IRouter = Router();

router.get(
  "/admin/staffing/live",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Active staff roster + their current availability.
    const { data: admins, error: adminsErr } = await supabase
      .from("admin_users")
      .select("id, email_lower, display_name, role, availability")
      .eq("status", "active");
    if (adminsErr) throw adminsErr;
    const agents = (admins ?? []).map(
      (a: Database["resupply"]["Tables"]["admin_users"]["Row"]) => ({
        id: a.id,
        email: a.email_lower,
        displayName: a.display_name,
        role: a.role,
        availability: a.availability,
      }),
    );

    // Page past PostgREST's max_rows cap (1000). A bare `.limit(20000)`
    // silently truncates to an UNORDERED first ~1000 rows and reports the
    // partial tally as if it were complete — same trap mask-fit rec-signal
    // and fitter-outcomes already page around. Newest-first so a full
    // queue window still reflects current load, not an oldest-frozen slice.
    type ConvoRow = { assigned_admin_user_id: string | null };
    const openConversationAssignees: Array<string | null> = [];
    for (
      let offset = 0;
      offset < OPEN_CONVO_MAX_ROWS;
      offset += OPEN_CONVO_PAGE
    ) {
      const { data: convos, error: convErr } = await supabase
        .from("conversations")
        .select("assigned_admin_user_id")
        .in("status", OPEN_CONVERSATION_STATUSES)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + OPEN_CONVO_PAGE - 1);
      if (convErr) throw convErr;
      const page = (convos ?? []) as ConvoRow[];
      for (const c of page) {
        openConversationAssignees.push(c.assigned_admin_user_id ?? null);
      }
      if (page.length < OPEN_CONVO_PAGE) break;
    }

    // Who's on shift right now (started, not ended, not called off).
    // Page past PostgREST max_rows — a bare high `.limit(...)` silently
    // truncated at ~1000 unordered shift rows.
    const nowIso = new Date().toISOString();
    const SHIFT_PAGE = 1000;
    const onShiftIds: string[] = [];
    for (let from = 0; ; from += SHIFT_PAGE) {
      const { data: shifts, error: shiftErr } = await supabase
        .from("csr_shifts")
        .select("staff_user_id")
        .lte("starts_at", nowIso)
        .gt("ends_at", nowIso)
        .neq("status", "called_off")
        .order("id", { ascending: true })
        .range(from, from + SHIFT_PAGE - 1);
      if (shiftErr) throw shiftErr;
      const page = (shifts ?? []) as Array<{
        staff_user_id: string | null;
      }>;
      for (const s of page) {
        if (s.staff_user_id) onShiftIds.push(s.staff_user_id);
      }
      if (page.length < SHIFT_PAGE) break;
    }

    res.json({
      ...buildLiveStaffing({
        agents,
        openConversationAssignees,
        onShiftIds,
      }),
      // True when the newest-first window filled — older open threads
      // beyond the most recent 20k exist and are not in this tally.
      windowTruncated: openConversationAssignees.length >= OPEN_CONVO_MAX_ROWS,
    });
  },
);

export default router;
