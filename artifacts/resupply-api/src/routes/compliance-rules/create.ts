// POST /compliance-rules — create a per-payer adherence rule.
//
// Mirrors /rules (frequency_rules) but for the compliance thresholds
// resolved by resupply.resolve_compliance_thresholds() inside the
// therapy-fleet / setup-adherence RPCs (migration 0212). `min_minutes`
// (qualifying nightly minutes, 240 = the CMS 4h rule) and
// `required_nights` (qualifying nights in the window, 21 = the CMS
// 21-of-30 rule) are the two tunable thresholds. `matchInsurancePayer`
// null = a catch-all rule; the seeded default (NULL payer, priority
// 1000) is the CMS fallback.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

// Shared shape used by both POST and PATCH. PATCH wraps every field in
// `.optional()`; here `name` is required and the thresholds carry the
// CMS defaults so a rule created without them slots in as a Medicare
// rule.
export const complianceRuleBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    priority: z.number().int().min(0).max(100000).default(100),
    matchInsurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
    // 0..1440 minutes (a night can't exceed 24h). 240 = 4 hours.
    minMinutes: z.number().int().min(0).max(1440).default(240),
    // 1..30 qualifying nights in a (≤30-day) window. 21 = CMS.
    requiredNights: z.number().int().min(1).max(30).default(21),
    active: z.boolean().default(true),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/compliance-rules",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = complianceRuleBody.safeParse(req.body);
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
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("compliance_rules")
      .insert({
        name: parsed.data.name,
        priority: parsed.data.priority,
        match_insurance_payer: parsed.data.matchInsurancePayer ?? null,
        min_minutes: parsed.data.minMinutes,
        required_nights: parsed.data.requiredNights,
        active: parsed.data.active,
        notes: parsed.data.notes ?? null,
      })
      .select("*")
      .single();
    if (error) throw error;

    try {
      await logAudit({
        action: "compliance_rules.create",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "compliance_rules",
        targetId: row.id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          ruleName: row.name,
          priority: row.priority,
          minMinutes: row.min_minutes,
          requiredNights: row.required_nights,
        },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "compliance_rules.create: audit write failed",
      );
    }

    res.status(201).json({
      id: row.id,
      name: row.name,
      priority: row.priority,
      matchInsurancePayer: row.match_insurance_payer,
      minMinutes: row.min_minutes,
      requiredNights: row.required_nights,
      active: row.active,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },
);

export default router;
