// POST /rules — create a frequency rule.
//
// Body shape mirrors the row shape minus the server-managed columns
// (id, createdAt, updatedAt). All `match_*` predicates are optional
// — leaving them out (or sending null) means "this rule does not
// constrain on that axis". `priority` defaults to 100 (the same
// default as the column) so a rule created without one slots in
// next to other unprioritised rules.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

// Shared shape used by both POST and PATCH. PATCH wraps every field
// in `.optional()`; here we keep `name` and `cadenceDays` required.
const ruleBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    priority: z.number().int().min(0).max(100000).default(100),
    matchItemSkuPrefix: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
    matchInsurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
    minTenureDays: z.number().int().min(0).max(36500).nullable().optional(),
    maxTenureDays: z.number().int().min(0).max(36500).nullable().optional(),
    cadenceDays: z.number().int().min(1).max(365),
    defaultChannel: z.enum(["sms", "email", "voice"]).nullable().optional(),
    active: z.boolean().default(true),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.minTenureDays != null &&
      val.maxTenureDays != null &&
      val.minTenureDays > val.maxTenureDays
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minTenureDays must be <= maxTenureDays",
        path: ["minTenureDays"],
      });
    }
  });

const router: IRouter = Router();

router.post("/rules", adminWriteRateLimiter, requireAdmin, async (req, res) => {
  const parsed = ruleBody.safeParse(req.body);
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
    .from("frequency_rules")
    .insert({
      name: parsed.data.name,
      priority: parsed.data.priority,
      match_item_sku_prefix: parsed.data.matchItemSkuPrefix ?? null,
      match_insurance_payer: parsed.data.matchInsurancePayer ?? null,
      min_tenure_days: parsed.data.minTenureDays ?? null,
      max_tenure_days: parsed.data.maxTenureDays ?? null,
      cadence_days: parsed.data.cadenceDays,
      default_channel: parsed.data.defaultChannel ?? null,
      active: parsed.data.active,
      notes: parsed.data.notes ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;

  try {
    await logAudit({
      action: "rules.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "frequency_rules",
      targetId: row.id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { ruleName: row.name, priority: row.priority },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "rules.create: audit write failed",
    );
  }

  res.status(201).json({
    id: row.id,
    name: row.name,
    priority: row.priority,
    matchItemSkuPrefix: row.match_item_sku_prefix,
    matchInsurancePayer: row.match_insurance_payer,
    minTenureDays: row.min_tenure_days,
    maxTenureDays: row.max_tenure_days,
    cadenceDays: row.cadence_days,
    defaultChannel: row.default_channel,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

export default router;
