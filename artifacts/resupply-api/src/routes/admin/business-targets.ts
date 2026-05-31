// /admin/business-targets — owner goal / target tracking (migration 0190
// / Phase 1, Owner #8). Set a target for a headline KPI per period; the
// F2 metrics_daily series provides the actuals for a future pace-to-goal
// view (joined by metric_key + period).
//
//   GET /admin/business-targets[?period=2026-05]  — list targets
//   PUT /admin/business-targets                   — upsert one target
//
// Management-gated (targets.manage — owner/admin tier, off the CSR
// bucket). Not PHI; the audit envelope records the structural fields.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const PERIOD_RE = /^[0-9A-Za-z-]+$/;

const listQuery = z
  .object({
    period: z.string().trim().min(1).max(20).regex(PERIOD_RE).optional(),
  })
  .strip();

const upsertSchema = z
  .object({
    metricKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, "metricKey must be lower_snake_case."),
    period: z.string().trim().min(1).max(20).regex(PERIOD_RE),
    targetValue: z.number().finite().min(0),
    unit: z.enum(["count", "cents", "ratio", "pct", "days"]).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

const TARGET_SELECT =
  "id, metric_key, period, target_value, unit, notes, created_by_email, created_at, updated_at";

function mapTarget(r: Record<string, unknown>) {
  return {
    id: r.id,
    metricKey: r.metric_key,
    period: r.period,
    targetValue: r.target_value,
    unit: r.unit,
    notes: r.notes,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/business-targets",
  requirePermission("targets.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    const period = parsed.success ? parsed.data.period : undefined;

    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("business_targets")
      .select(TARGET_SELECT)
      .order("period", { ascending: false })
      .limit(500);
    if (period) query = query.eq("period", period);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    res.json({ targets: rows.map(mapTarget) });
  },
);

router.put(
  "/admin/business-targets",
  requirePermission("targets.manage"),
  adminRateLimit({ name: "business_targets.upsert", preset: "mutation" }),
  async (req, res) => {
    const parsed = upsertSchema.safeParse(req.body);
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("business_targets")
      .upsert(
        {
          metric_key: d.metricKey,
          period: d.period,
          target_value: d.targetValue,
          unit: d.unit ?? "count",
          notes: d.notes ?? null,
          created_by_email: req.adminEmail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "metric_key,period" },
      )
      .select(TARGET_SELECT)
      .single();
    if (error) {
      res.status(500).json({ error: "upsert_failed", message: error.message });
      return;
    }

    await logAudit({
      action: "business_target.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "business_targets",
      targetId: `${d.metricKey}:${d.period}`,
      metadata: {
        metric_key: d.metricKey,
        period: d.period,
        target_value: d.targetValue,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "business_target.upsert audit write failed");
    });

    res.json(mapTarget(row as Record<string, unknown>));
  },
);

export default router;
