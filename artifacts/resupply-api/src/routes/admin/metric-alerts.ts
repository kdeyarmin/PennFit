// /admin/metric-alerts — the in-app KPI alert feed (migration 0194 / F2).
//
//   GET   /admin/metric-alerts            — list (filter by status)
//   PATCH /admin/metric-alerts/:id        — acknowledge / resolve
//
// Alerts are written by the metrics.alerts-evaluator worker; this is the
// operator surface to triage them. Gated on `metrics.read` (management
// tier — KPI/revenue alerts are owner-and-management data, off the
// front-line customer_service_rep bucket, same posture as cost.read).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const listQuery = z
  .object({
    status: z.enum(["open", "acknowledged", "resolved", "all"]).optional(),
  })
  .strip();

const idParam = z.string().trim().min(1).max(64);

const patchSchema = z
  .object({
    status: z.enum(["open", "acknowledged", "resolved"]),
  })
  .strict();

router.get(
  "/admin/metric-alerts",
  requirePermission("metrics.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;

    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("metric_alerts")
      .select(
        "id, threshold_id, metric_key, metric_date, observed_value, compared_value, baseline_value, severity, message, status, notified_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    // Default to the actionable feed (open) unless an explicit filter is
    // given; status=all returns everything.
    const effective = status ?? "open";
    if (effective !== "all") query = query.eq("status", effective);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        thresholdId: r.threshold_id,
        metricKey: r.metric_key,
        metricDate: r.metric_date,
        observedValue: r.observed_value,
        comparedValue: r.compared_value,
        baselineValue: r.baseline_value,
        severity: r.severity,
        message: r.message,
        status: r.status,
        notifiedAt: r.notified_at,
        createdAt: r.created_at,
      })),
    });
  },
);

router.patch(
  "/admin/metric-alerts/:id",
  requirePermission("metrics.read"),
  adminRateLimit({ name: "metric_alerts.update", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idCheck.data;

    const parsed = patchSchema.safeParse(req.body);
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
    const { status } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: updatedData, error } = await supabase
      .schema("resupply")
      .from("metric_alerts")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, status")
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    const updated = updatedData as Record<string, unknown> | null;
    if (!updated) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }

    await logAudit({
      action: "metric_alert.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "metric_alerts",
      targetId: id,
      metadata: { status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "metric_alert.update audit write failed");
    });

    res.json({ id: updated.id, status: updated.status });
  },
);

export default router;
