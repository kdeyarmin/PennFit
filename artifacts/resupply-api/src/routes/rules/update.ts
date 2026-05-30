// PATCH /rules/:id — update a frequency rule.
//
// Every field is optional; only the keys present in the request body
// are written. `null` explicitly clears a nullable field. This is the
// same PATCH-with-nullable-clears idiom used by /patients/:id.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

type FrequencyRulesUpdate =
  Database["resupply"]["Tables"]["frequency_rules"]["Update"];

// camelCase request keys → snake_case DB columns. Keeping the body
// shape the same as `create.ts` so the frontend doesn't need to know
// the column names.
const FIELD_MAP = {
  name: "name",
  priority: "priority",
  matchItemSkuPrefix: "match_item_sku_prefix",
  matchInsurancePayer: "match_insurance_payer",
  minTenureDays: "min_tenure_days",
  maxTenureDays: "max_tenure_days",
  cadenceDays: "cadence_days",
  defaultChannel: "default_channel",
  active: "active",
  notes: "notes",
} as const;

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
    defaultChannel: z.enum(["sms", "email", "voice"]).nullable().optional(),
    active: z.boolean().optional(),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    // Optional ISO-8601 timestamp the client read with the row.
    // When supplied, the UPDATE is conditioned on the row's current
    // updated_at matching it (optimistic-concurrency guard).
    expectedUpdatedAt: z.string().datetime().optional(),
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
  // Optimistic-concurrency precondition: the client must echo back
  // the `updatedAt` it read with the row, and the UPDATE only lands
  // when the DB still shows that timestamp. Without this guard, two
  // admins editing the same rule concurrently each `UPDATE ... WHERE
  // id = $id` — the later writer silently wins, the loser's
  // `active: false` toggle vanishes with a 200 response, and the
  // rule keeps firing. Rules drive the eligibility engine so a lost
  // toggle is observable patient-side.
  const expectedUpdatedAt =
    typeof (body as Record<string, unknown>).expectedUpdatedAt === "string"
      ? ((body as Record<string, unknown>).expectedUpdatedAt as string)
      : null;
  const updates: FrequencyRulesUpdate = {};
  const changedKeys: string[] = [];
  for (const [camel, snake] of Object.entries(FIELD_MAP) as Array<
    [keyof typeof FIELD_MAP, (typeof FIELD_MAP)[keyof typeof FIELD_MAP]]
  >) {
    if (camel in body) {
      const value = (body as Record<string, unknown>)[camel] ?? null;
      // Cast through `unknown` because each column is its own narrow
      // union; the per-key write is type-safe at the call site.
      (updates as Record<string, unknown>)[snake] = value;
      changedKeys.push(camel);
    }
  }

  // Cross-field validation: if either tenure bound is being touched
  // and BOTH end up non-null, enforce min <= max. We only have the
  // partial picture from the request body, so we resolve against the
  // existing row.
  const supabase = getSupabaseServiceRoleClient();
  if ("minTenureDays" in body || "maxTenureDays" in body) {
    const { data: existing } = await supabase
      .schema("resupply")
      .from("frequency_rules")
      .select("min_tenure_days, max_tenure_days")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const finalMin =
      "minTenureDays" in body
        ? (body.minTenureDays ?? null)
        : existing.min_tenure_days;
    const finalMax =
      "maxTenureDays" in body
        ? (body.maxTenureDays ?? null)
        : existing.max_tenure_days;
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

  if (changedKeys.length === 0) {
    res.status(200).json({ id: idParsed.data.id, changed: [] });
    return;
  }

  updates.updated_at = new Date().toISOString();

  let updateBuilder = supabase
    .schema("resupply")
    .from("frequency_rules")
    .update(updates)
    .eq("id", idParsed.data.id);
  if (expectedUpdatedAt) {
    updateBuilder = updateBuilder.eq("updated_at", expectedUpdatedAt);
  }
  const { data: result, error } = await updateBuilder.select("id");
  if (error) throw error;

  if (!result || result.length === 0) {
    if (expectedUpdatedAt) {
      // Distinguish "concurrent update overwrote our base value"
      // from "row doesn't exist" so the UI can prompt a refresh
      // instead of a generic "not found" toast.
      const { data: stillExists } = await supabase
        .schema("resupply")
        .from("frequency_rules")
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

  const changedColumns = changedKeys;
  try {
    await logAudit({
      action: "rules.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "frequency_rules",
      targetId: idParsed.data.id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { columns: changedColumns },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "rules.update: audit write failed",
    );
  }

  res.status(200).json({ id: idParsed.data.id, changed: changedColumns });
});

export default router;
