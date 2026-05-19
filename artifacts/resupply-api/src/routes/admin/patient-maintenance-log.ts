// /admin/patients/:id/maintenance-log — CSR view of the patient's
// hygiene-task completion history (cushion clean, headgear wash,
// humidifier descale, filter change). Read-only — the only writes
// are from the patient portal's POST /shop/me/maintenance handler.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/patients/:id/maintenance-log",
  // Read-only view of the patient's hygiene-task history. Scoped
  // to `patients.read` — held by every current admin role, so this
  // documents the contract without changing today's access matrix.
  requirePermission("patients.read"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_maintenance_log")
      .select(
        "id, task_key, completed_at, source, created_at",
      )
      .eq("patient_id", idParse.data)
      .order("completed_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    // Group latest-per-task so the CSR sees "cushion clean: 6 days
    // ago" without scanning the full list.
    const latestByTask: Record<string, string> = {};
    for (const r of data ?? []) {
      if (!latestByTask[r.task_key] || r.completed_at > latestByTask[r.task_key]!) {
        latestByTask[r.task_key] = r.completed_at;
      }
    }

    res.json({
      entries: (data ?? []).map((r) => ({
        id: r.id,
        taskKey: r.task_key,
        completedAt: r.completed_at,
        source: r.source,
        createdAt: r.created_at,
      })),
      latestByTask,
    });
  },
);

export default router;
