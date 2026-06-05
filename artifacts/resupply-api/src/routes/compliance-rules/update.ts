// PATCH /compliance-rules/:id — update a compliance rule.
//
// Every field is optional; only keys present in the body are written.
// `null` explicitly clears a nullable field. Uses the same optimistic-
// concurrency guard as /rules: the client echoes the `updatedAt` it read
// and the UPDATE only lands when the DB still shows it, so a concurrent
// edit can't silently clobber a toggle. Rules feed the compliance RPCs,
// so a lost toggle is observable in the fleet dashboards.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

type ComplianceRulesUpdate =
  Database["resupply"]["Tables"]["compliance_rules"]["Update"];

// camelCase request keys → snake_case DB columns.
const FIELD_MAP = {
  name: "name",
  priority: "priority",
  matchInsurancePayer: "match_insurance_payer",
  minMinutes: "min_minutes",
  requiredNights: "required_nights",
  windowDays: "window_days",
  active: "active",
  notes: "notes",
} as const;

const idParam = z.object({ id: z.string().uuid() });

export const compliancePatchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    priority: z.number().int().min(0).max(100000).optional(),
    matchInsurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    minMinutes: z.number().int().min(0).max(1440).optional(),
    requiredNights: z.number().int().min(1).max(30).optional(),
    windowDays: z.number().int().min(7).max(90).optional(),
    active: z.boolean().optional(),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    // Optional ISO-8601 timestamp the client read with the row. When
    // supplied, the UPDATE is conditioned on updated_at matching it.
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict();

const router: IRouter = Router();

router.patch(
  "/compliance-rules/:id",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = compliancePatchBody.safeParse(req.body);
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
    const expectedUpdatedAt =
      typeof (body as Record<string, unknown>).expectedUpdatedAt === "string"
        ? ((body as Record<string, unknown>).expectedUpdatedAt as string)
        : null;
    const updates: ComplianceRulesUpdate = {};
    const changedKeys: string[] = [];
    for (const [camel, snake] of Object.entries(FIELD_MAP) as Array<
      [keyof typeof FIELD_MAP, (typeof FIELD_MAP)[keyof typeof FIELD_MAP]]
    >) {
      if (camel in body) {
        const value = (body as Record<string, unknown>)[camel] ?? null;
        (updates as Record<string, unknown>)[snake] = value;
        changedKeys.push(camel);
      }
    }

    if (changedKeys.length === 0) {
      res.status(200).json({ id: idParsed.data.id, changed: [] });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const supabase = getSupabaseServiceRoleClient();
    let updateBuilder = supabase
      .schema("resupply")
      .from("compliance_rules")
      .update(updates)
      .eq("id", idParsed.data.id);
    if (expectedUpdatedAt) {
      updateBuilder = updateBuilder.eq("updated_at", expectedUpdatedAt);
    }
    const { data: result, error } = await updateBuilder.select("id");
    if (error) {
      // A CHECK violation here is the requiredNights <= windowDays guard
      // (the one cross-field rule Zod can't enforce on a partial PATCH).
      if ((error as { code?: string }).code === "23514") {
        res.status(400).json({
          error: "invalid_body",
          issues: [
            {
              path: "requiredNights",
              message: "requiredNights cannot exceed windowDays",
            },
          ],
        });
        return;
      }
      throw error;
    }

    if (!result || result.length === 0) {
      if (expectedUpdatedAt) {
        const { data: stillExists } = await supabase
          .schema("resupply")
          .from("compliance_rules")
          .select("id")
          .eq("id", idParsed.data.id)
          .limit(1)
          .maybeSingle();
        if (stillExists) {
          res.status(409).json({
            error: "concurrent_modification",
            message:
              "Another team member updated this rule while you were editing. Refresh and try again.",
          });
          return;
        }
      }
      res.status(404).json({ error: "not_found" });
      return;
    }

    try {
      await logAudit({
        action: "compliance_rules.update",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "compliance_rules",
        targetId: idParsed.data.id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: { columns: changedKeys },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "compliance_rules.update: audit write failed",
      );
    }

    res.status(200).json({ id: idParsed.data.id, changed: changedKeys });
  },
);

export default router;
