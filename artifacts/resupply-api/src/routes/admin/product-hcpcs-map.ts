// /admin/product-hcpcs-map — SKU → HCPCS catalog admin.
//
//   GET   /admin/product-hcpcs-map?lookupKind=item_sku&q=...
//   POST  /admin/product-hcpcs-map        admin-only
//   PATCH /admin/product-hcpcs-map/:id    admin-only

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

type Row = Database["resupply"]["Tables"]["product_hcpcs_map"]["Row"];

const LOOKUP_KIND_VALUES = ["stripe_product_id", "item_sku"] as const satisfies readonly Row["lookup_kind"][];

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MOD_CSV_RE = /^([A-Z0-9]{2})(,[A-Z0-9]{2})*$/;

const upsertBody = z
  .object({
    lookupKind: z.enum(LOOKUP_KIND_VALUES),
    lookupValue: z.string().trim().min(1).max(120),
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((s) => s.toUpperCase())
      .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
    defaultModifiers: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .optional()
      .transform((s) => (s ? s.toUpperCase() : s))
      .refine(
        (s) => s == null || s === "" || MOD_CSV_RE.test(s),
        "must be a CSV of 2-char alphanumeric modifiers",
      ),
    unitsPerDispense: z.number().int().min(1).max(9999).default(1),
    defaultBilledCents: z.number().int().min(0).nullable().optional(),
    description: z.string().trim().max(240).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

const patchBody = upsertBody.partial();

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  return {
    id: r.id,
    lookupKind: r.lookup_kind,
    lookupValue: r.lookup_value,
    hcpcsCode: r.hcpcs_code,
    defaultModifiers: r.default_modifiers,
    unitsPerDispense: r.units_per_dispense,
    defaultBilledCents: r.default_billed_cents,
    description: r.description,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/product-hcpcs-map",
  requirePermission("reports.read"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("product_hcpcs_map")
    .select(
      "id, lookup_kind, lookup_value, hcpcs_code, default_modifiers, units_per_dispense, default_billed_cents, description, is_active, created_at, updated_at",
    )
    .order("lookup_value", { ascending: true })
    .limit(500);
  const lookupKind =
    typeof req.query.lookupKind === "string" ? req.query.lookupKind : undefined;
  if (lookupKind && (LOOKUP_KIND_VALUES as readonly string[]).includes(lookupKind)) {
    query = query.eq("lookup_kind", lookupKind as Row["lookup_kind"]);
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length > 0 && q.length <= 80) {
    const safe = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    query = query.ilike("lookup_value", `%${safe}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  res.json({ rows: (data ?? []).map(rowToApi) });
});

router.post(
  "/admin/product-hcpcs-map",
  requireAdminOnly,
  adminRateLimit({ name: "product_hcpcs_map.create", preset: "sensitive" }),
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
    .from("product_hcpcs_map")
    .insert({
      lookup_kind: b.lookupKind,
      lookup_value: b.lookupValue,
      hcpcs_code: b.hcpcsCode,
      default_modifiers: b.defaultModifiers ?? null,
      units_per_dispense: b.unitsPerDispense,
      default_billed_cents: b.defaultBilledCents ?? null,
      description: b.description ?? null,
      is_active: b.isActive,
    })
    .select("id")
    .single();
  if (error) {
    if (typeof error.code === "string" && error.code === "23505") {
      res.status(409).json({ error: "lookup_conflict" });
      return;
    }
    throw error;
  }
  await logAudit({
    action: "product_hcpcs_map.create",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "product_hcpcs_map",
    targetId: data.id,
    metadata: { lookup_kind: b.lookupKind, lookup_value: b.lookupValue, hcpcs_code: b.hcpcsCode },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "product_hcpcs_map.create audit write failed");
  });
  res.status(201).json({ id: data.id });
});

router.patch(
  "/admin/product-hcpcs-map/:id",
  requireAdminOnly,
  adminRateLimit({ name: "product_hcpcs_map.update", preset: "mutation" }),
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
    const update: Database["resupply"]["Tables"]["product_hcpcs_map"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.lookupKind !== undefined) update.lookup_kind = b.lookupKind;
    if (b.lookupValue !== undefined) update.lookup_value = b.lookupValue;
    if (b.hcpcsCode !== undefined) update.hcpcs_code = b.hcpcsCode;
    if (b.defaultModifiers !== undefined) update.default_modifiers = b.defaultModifiers;
    if (b.unitsPerDispense !== undefined) update.units_per_dispense = b.unitsPerDispense;
    if (b.defaultBilledCents !== undefined) update.default_billed_cents = b.defaultBilledCents;
    if (b.description !== undefined) update.description = b.description;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("product_hcpcs_map")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "product_hcpcs_map.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "product_hcpcs_map",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "product_hcpcs_map.update audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
