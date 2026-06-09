// /admin/office-hours — the practice's standard weekly open hours.
//
//   GET /admin/office-hours  — list the open windows (one row per window
//                              per weekday).
//   PUT /admin/office-hours  — replace the WHOLE weekly schedule.
//
// office_hours is the positive "open by default" baseline; office_closures /
// office_recurring_closures are the explicit "closed" exceptions. The company
// calendar shades time outside office hours as unavailable and defaults new
// appointments into the open window. Times are UTC `time` (no date), matching
// office_recurring_closures.
//
// Gated by admin.tools.manage (same supervisor-tier tool-management perm as
// office-closures) so the architecture/route-gate check stays green.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const TIME_HHMMSS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

const windowSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    openTimeUtc: z.string().regex(TIME_HHMMSS),
    closeTimeUtc: z.string().regex(TIME_HHMMSS),
  })
  .strict()
  .refine((w) => w.closeTimeUtc > w.openTimeUtc, {
    message: "closeTimeUtc must be later than openTimeUtc",
  });

// Replace-the-whole-schedule body. An empty array is valid — it means "no
// standard open hours" (the calendar then treats every day as outside hours).
const putBody = z
  .object({
    windows: z.array(windowSchema).max(50),
  })
  .strict();

router.get(
  "/admin/office-hours",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("office_hours")
      .select(
        "id, day_of_week, open_time_utc, close_time_utc, active, created_at, updated_at",
      )
      .order("day_of_week", { ascending: true })
      .order("open_time_utc", { ascending: true })
      .limit(200);
    if (error) throw error;
    res.json({
      windows: (data ?? []).map((r) => ({
        id: r.id,
        dayOfWeek: r.day_of_week,
        openTimeUtc: r.open_time_utc,
        closeTimeUtc: r.close_time_utc,
        active: r.active === 1,
      })),
    });
  },
);

router.put(
  "/admin/office-hours",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "office_hours.replace", preset: "mutation" }),
  async (req, res) => {
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    // Replace the schedule: clear all rows, then insert the new set. The
    // body is fully validated above, so the insert won't fail on shape. The
    // `.not("id", "is", null)` filter is PostgREST's "match every row" form
    // (a bare delete is refused as a guard against accidental full wipes).
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("office_hours")
      .delete()
      .not("id", "is", null);
    if (delErr) throw delErr;

    if (parsed.data.windows.length > 0) {
      const rows = parsed.data.windows.map((w) => ({
        day_of_week: w.dayOfWeek,
        open_time_utc: w.openTimeUtc,
        close_time_utc: w.closeTimeUtc,
        active: 1,
        created_by_user_id: req.adminUserId ?? null,
      }));
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("office_hours")
        .insert(rows);
      if (insErr) throw insErr;
    }

    res.json({ ok: true });
  },
);

export default router;
