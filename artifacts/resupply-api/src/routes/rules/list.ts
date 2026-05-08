// GET /rules — list every frequency rule (active + inactive).
//
// The dashboard's rules page needs both states so admins can
// toggle a rule back on without re-creating it. We sort by the same
// (priority asc, createdAt asc) the eligibility engine uses so the
// page reads top-to-bottom in evaluation order.
//
// No PHI on this table; no per-row audit. We do log a single
// `rules.list` audit row to record the read for compliance.

import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/rules", requireAdmin, async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("frequency_rules")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }
  const rows = data ?? [];

  try {
    await logAudit({
      action: "rules.list",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "frequency_rules",
      targetId: null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { count: rows.length },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "rules.list: audit write failed",
    );
  }

  res.status(200).json({
    rules: rows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      matchItemSkuPrefix: r.match_item_sku_prefix,
      matchInsurancePayer: r.match_insurance_payer,
      minTenureDays: r.min_tenure_days,
      maxTenureDays: r.max_tenure_days,
      cadenceDays: r.cadence_days,
      defaultChannel: r.default_channel,
      active: r.active,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

export default router;
