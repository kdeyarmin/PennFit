// PATCH /rules/:id — update a frequency rule.
//
// Every field is optional; only the keys present in the request body
// are written. `null` explicitly clears a nullable field. This is the
// same PATCH-with-nullable-clears idiom used by /patients/:id.

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { frequencyRules, getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    priority: z.number().int().min(0).max(100000).optional(),
    matchItemSkuPrefix: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    matchInsurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    minTenureDays: z.number().int().min(0).max(36500).nullable().optional(),
    maxTenureDays: z.number().int().min(0).max(36500).nullable().optional(),
    cadenceDays: z.number().int().min(1).max(365).optional(),
    defaultChannel: z
      .enum(["sms", "email", "voice"])
      .nullable()
      .optional(),
    active: z.boolean().optional(),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .strict();

const router: IRouter = Router();

router.patch("/rules/:id", requireAdmin, async (req, res) => {
  const idParsed = idParam.safeParse(req.params);
  if (!idParsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const bodyParsed = patchBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: bodyParsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  const body = bodyParsed.data;
  const updates: Record<string, unknown> = {};
  for (const k of [
    "name",
    "priority",
    "matchItemSkuPrefix",
    "matchInsurancePayer",
    "minTenureDays",
    "maxTenureDays",
    "cadenceDays",
    "defaultChannel",
    "active",
    "notes",
  ] as const) {
    if (k in body) updates[k] = (body as Record<string, unknown>)[k] ?? null;
  }

  // Cross-field validation: if either tenure bound is being touched
  // and BOTH end up non-null, enforce min <= max. We only have the
  // partial picture from the request body, so we resolve against the
  // existing row.
  if (
    updates.minTenureDays !== undefined ||
    updates.maxTenureDays !== undefined
  ) {
    const db = drizzle(getDbPool());
    const [existing] = await db
      .select({
        minTenureDays: frequencyRules.minTenureDays,
        maxTenureDays: frequencyRules.maxTenureDays,
      })
      .from(frequencyRules)
      .where(eq(frequencyRules.id, idParsed.data.id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const finalMin =
      "minTenureDays" in updates
        ? (updates.minTenureDays as number | null)
        : existing.minTenureDays;
    const finalMax =
      "maxTenureDays" in updates
        ? (updates.maxTenureDays as number | null)
        : existing.maxTenureDays;
    if (finalMin != null && finalMax != null && finalMin > finalMax) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "minTenureDays",
            message: "minTenureDays must be <= maxTenureDays",
          },
        ],
      });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(200).json({ id: idParsed.data.id, changed: [] });
    return;
  }

  updates.updatedAt = sql`now()`;

  const db = drizzle(getDbPool());
  const result = await db
    .update(frequencyRules)
    .set(updates)
    .where(eq(frequencyRules.id, idParsed.data.id))
    .returning({ id: frequencyRules.id });

  if (result.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const changedColumns = Object.keys(updates).filter((k) => k !== "updatedAt");
  try {
    await logAudit({
      action: "rules.update",
      adminEmail: req.adminEmail ?? null,
      adminClerkId: req.adminClerkId ?? null,
      targetTable: "frequency_rules",
      targetId: idParsed.data.id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { columns: changedColumns },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "rules.update: audit write failed",
    );
  }

  res.status(200).json({ id: idParsed.data.id, changed: changedColumns });
});

export default router;
