// GET /compliance-rules — list every compliance rule (active + inactive).
//
// Sorted by the same (priority asc, createdAt asc) the resolver uses, so
// the page reads top-to-bottom in evaluation order. No PHI on this
// table; we log a single `compliance_rules.list` audit row for the read.

import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/compliance-rules",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("compliance_rules")
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
        action: "compliance_rules.list",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "compliance_rules",
        targetId: null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: { count: rows.length },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "compliance_rules.list: audit write failed",
      );
    }

    res.status(200).json({
      rules: rows.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        matchInsurancePayer: r.match_insurance_payer,
        minMinutes: r.min_minutes,
        requiredNights: r.required_nights,
        active: r.active,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

export default router;
