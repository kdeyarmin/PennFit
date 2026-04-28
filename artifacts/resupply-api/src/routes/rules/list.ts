// GET /rules — list every frequency rule (active + inactive).
//
// The dashboard's rules page needs both states so admins can
// toggle a rule back on without re-creating it. We sort by the same
// (priority asc, createdAt asc) the eligibility engine uses so the
// page reads top-to-bottom in evaluation order.
//
// No PHI on this table; no per-row audit. We do log a single
// `rules.list` audit row to record the read for compliance.

import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { frequencyRules, getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/rules", requireAdmin, async (req, res) => {
  const db = drizzle(getDbPool());

  const rows = await db
    .select()
    .from(frequencyRules)
    .orderBy(asc(frequencyRules.priority), asc(frequencyRules.createdAt));

  try {
    await logAudit({
      action: "rules.list",
      adminEmail: req.adminEmail ?? null,
      adminClerkId: req.adminClerkId ?? null,
      targetTable: "frequency_rules",
      targetId: null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { count: rows.length },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "rules.list: audit write failed",
    );
  }

  res.status(200).json({
    rules: rows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      matchItemSkuPrefix: r.matchItemSkuPrefix,
      matchInsurancePayer: r.matchInsurancePayer,
      minTenureDays: r.minTenureDays,
      maxTenureDays: r.maxTenureDays,
      cadenceDays: r.cadenceDays,
      defaultChannel: r.defaultChannel,
      active: r.active,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

export default router;
