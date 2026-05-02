// POST /rules — create a frequency rule.
//
// Body shape mirrors the row shape minus the server-managed columns
// (id, createdAt, updatedAt). All `match_*` predicates are optional
// — leaving them out (or sending null) means "this rule does not
// constrain on that axis". `priority` defaults to 100 (the same
// default as the column) so a rule created without one slots in
// next to other unprioritised rules.

import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { frequencyRules, getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
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
    defaultChannel: z
      .enum(["sms", "email", "voice"])
      .nullable()
      .optional(),
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

router.post("/rules", requireAdmin, async (req, res) => {
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

  const db = drizzle(getDbPool());
  const [row] = await db
    .insert(frequencyRules)
    .values({
      name: parsed.data.name,
      priority: parsed.data.priority,
      matchItemSkuPrefix: parsed.data.matchItemSkuPrefix ?? null,
      matchInsurancePayer: parsed.data.matchInsurancePayer ?? null,
      minTenureDays: parsed.data.minTenureDays ?? null,
      maxTenureDays: parsed.data.maxTenureDays ?? null,
      cadenceDays: parsed.data.cadenceDays,
      defaultChannel: parsed.data.defaultChannel ?? null,
      active: parsed.data.active,
      notes: parsed.data.notes ?? null,
    })
    .returning();

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
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "rules.create: audit write failed",
    );
  }

  res.status(201).json({
    id: row.id,
    name: row.name,
    priority: row.priority,
    matchItemSkuPrefix: row.matchItemSkuPrefix,
    matchInsurancePayer: row.matchInsurancePayer,
    minTenureDays: row.minTenureDays,
    maxTenureDays: row.maxTenureDays,
    cadenceDays: row.cadenceDays,
    defaultChannel: row.defaultChannel,
    active: row.active,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});

export default router;
