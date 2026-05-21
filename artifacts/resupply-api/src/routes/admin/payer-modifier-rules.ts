// /admin/payer-modifier-rules — payer + HCPCS modifier auto-attach rules.
//
//   GET   /admin/payer-modifier-rules?payerProfileId=&hcpcs=
//   POST  /admin/payer-modifier-rules        admin-only
//   PATCH /admin/payer-modifier-rules/:id    admin-only

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"];

const CONDITION_VALUES = [
  "always",
  "if_rental_month_le_3",
  "if_rental_month_ge_4",
  "if_purchased",
  "if_compliant_90day",
  "if_initial_dispense",
  "if_abn_on_file",
  "if_pa_approved",
] as const satisfies readonly Row["condition"][];

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MOD_CSV_RE = /^([A-Z0-9]{2})(,[A-Z0-9]{2})*$/;

const upsertBody = z
  .object({
    payerProfileId: z.string().uuid(),
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((s) => s.toUpperCase())
      .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
    condition: z.enum(CONDITION_VALUES).default("always"),
    modifiersCsv: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .transform((s) => s.toUpperCase())
      .refine((s) => MOD_CSV_RE.test(s), "must be a CSV of 2-char alphanumeric modifiers"),
    priority: z.number().int().min(0).max(32767).default(100),
    rationale: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

const patchBody = upsertBody.partial();

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  return {
    id: r.id,
    payerProfileId: r.payer_profile_id,
    hcpcsCode: r.hcpcs_code,
    condition: r.condition,
    modifiersCsv: r.modifiers_csv,
    priority: r.priority,
    rationale: r.rationale,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/payer-modifier-rules",
  requirePermission("reports.read"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("payer_modifier_rules")
    .select(
      "id, payer_profile_id, hcpcs_code, condition, modifiers_csv, priority, rationale, is_active, created_at, updated_at",
    )
    .order("payer_profile_id", { ascending: true })
    .order("hcpcs_code", { ascending: true })
    .order("priority", { ascending: true })
    .limit(500);
  const payerProfileId =
    typeof req.query.payerProfileId === "string" ? req.query.payerProfileId : undefined;
  if (payerProfileId) query = query.eq("payer_profile_id", payerProfileId);
  const hcpcs =
    typeof req.query.hcpcs === "string" ? req.query.hcpcs.toUpperCase() : undefined;
  if (hcpcs) query = query.eq("hcpcs_code", hcpcs);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ rules: (data ?? []).map(rowToApi) });
});

router.post(
  "/admin/payer-modifier-rules",
  requireAdminOnly,
  adminRateLimit({ name: "payer_modifier_rules.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_modifier_rules")
      .insert({
        payer_profile_id: b.payerProfileId,
        hcpcs_code: b.hcpcsCode,
        condition: b.condition,
        modifiers_csv: b.modifiersCsv,
        priority: b.priority,
        rationale: b.rationale ?? null,
        is_active: b.isActive,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "payer_modifier_rule.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_modifier_rules",
      targetId: data.id,
      metadata: {
        payer_profile_id: b.payerProfileId,
        hcpcs_code: b.hcpcsCode,
        condition: b.condition,
        modifiers: b.modifiersCsv,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_modifier_rule.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/payer-modifier-rules/:id",
  requireAdminOnly,
  adminRateLimit({ name: "payer_modifier_rules.update", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["payer_modifier_rules"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.payerProfileId !== undefined) update.payer_profile_id = b.payerProfileId;
    if (b.hcpcsCode !== undefined) update.hcpcs_code = b.hcpcsCode;
    if (b.condition !== undefined) update.condition = b.condition;
    if (b.modifiersCsv !== undefined) update.modifiers_csv = b.modifiersCsv;
    if (b.priority !== undefined) update.priority = b.priority;
    if (b.rationale !== undefined) update.rationale = b.rationale;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("payer_modifier_rules")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "payer_modifier_rule.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_modifier_rules",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_modifier_rule.update audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
