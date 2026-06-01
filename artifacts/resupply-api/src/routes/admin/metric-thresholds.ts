// /admin/metric-thresholds — owner-facing config for the F2 KPI alert
// rules (Owner #5). The nightly metrics.alerts-evaluator walks every
// enabled threshold against metrics_daily and writes metric_alerts; this
// is the CRUD that lets the owner create / tune / disable those rules
// without SQL (the feed itself lives at /admin/metric-alerts).
//
// Reads on metrics.read; writes on admin.tools.manage (config is a
// supervisor-tier action). Not PHI — headline KPI rule config only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().uuid();

const COMPARISONS = ["gt", "gte", "lt", "lte"] as const;
const MODES = ["absolute", "delta_7d", "delta_pct_7d"] as const;
const SEVERITIES = ["info", "warning", "critical"] as const;

const createSchema = z
  .object({
    metricKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, "metricKey must be lower_snake_case."),
    comparison: z.enum(COMPARISONS),
    thresholdValue: z.number().finite(),
    mode: z.enum(MODES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    comparison: z.enum(COMPARISONS).optional(),
    thresholdValue: z.number().finite().optional(),
    mode: z.enum(MODES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .strict();

const SELECT =
  "id, metric_key, comparison, threshold_value, mode, severity, enabled, description, created_at, updated_at";

function mapThreshold(r: Record<string, unknown>) {
  return {
    id: r.id,
    metricKey: r.metric_key,
    comparison: r.comparison,
    thresholdValue: r.threshold_value,
    mode: r.mode,
    severity: r.severity,
    enabled: r.enabled,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/metric-thresholds",
  requirePermission("metrics.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("metric_thresholds")
      .select(SELECT)
      .order("metric_key", { ascending: true })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      thresholds: ((data ?? []) as Array<Record<string, unknown>>).map(
        mapThreshold,
      ),
    });
  },
);

router.post(
  "/admin/metric-thresholds",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "metric_thresholds.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
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
    const d = parsed.data;
    const nowIso = new Date().toISOString();
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("metric_thresholds")
      .insert({
        metric_key: d.metricKey,
        comparison: d.comparison,
        threshold_value: d.thresholdValue,
        mode: d.mode ?? "absolute",
        severity: d.severity ?? "warning",
        description: d.description ?? null,
        enabled: d.enabled ?? true,
        updated_at: nowIso,
      })
      .select(SELECT)
      .single();
    if (error) {
      res.status(500).json({ error: "insert_failed", message: error.message });
      return;
    }
    await logAudit({
      action: "metric_threshold.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "metric_thresholds",
      targetId: String((row as Record<string, unknown>).id ?? ""),
      metadata: {
        metric_key: d.metricKey,
        comparison: d.comparison,
        mode: d.mode ?? "absolute",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "metric_threshold.create audit write failed");
    });
    res.status(201).json(mapThreshold(row as Record<string, unknown>));
  },
);

router.patch(
  "/admin/metric-thresholds/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "metric_thresholds.update", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
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
    const d = parsed.data;
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (d.comparison !== undefined) update.comparison = d.comparison;
    if (d.thresholdValue !== undefined)
      update.threshold_value = d.thresholdValue;
    if (d.mode !== undefined) update.mode = d.mode;
    if (d.severity !== undefined) update.severity = d.severity;
    if (d.description !== undefined) update.description = d.description;
    if (d.enabled !== undefined) update.enabled = d.enabled;

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("metric_thresholds")
      .update(update)
      .eq("id", idCheck.data)
      .select(SELECT);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).json({ error: "threshold_not_found" });
      return;
    }
    await logAudit({
      action: "metric_threshold.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "metric_thresholds",
      targetId: idCheck.data,
      metadata: {
        fields: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "metric_threshold.update audit write failed");
    });
    res.json(mapThreshold(rows[0] as Record<string, unknown>));
  },
);

router.delete(
  "/admin/metric-thresholds/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "metric_thresholds.delete", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("metric_thresholds")
      .delete()
      .eq("id", idCheck.data)
      .select("id");
    if (error) {
      res.status(500).json({ error: "delete_failed", message: error.message });
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).json({ error: "threshold_not_found" });
      return;
    }
    await logAudit({
      action: "metric_threshold.delete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "metric_thresholds",
      targetId: idCheck.data,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "metric_threshold.delete audit write failed");
    });
    res.json({ ok: true, deletedId: idCheck.data });
  },
);

export default router;
