// /admin/shop/backorders + /admin/shop/sku-substitutes — CSR-facing
// management of the resupply backorder + substitution catalog.
//
// Both surfaces gate behind requireAdmin (any staff role can update
// backorder state — it's the CSR's day-to-day; substitution rows
// require admin_team.manage as a policy choice since they encode a
// clinical preference order that shouldn't be tweaked ad-hoc).
//
//   GET    /admin/shop/backorders             — list all rows
//   POST   /admin/shop/backorders             — body: { sku, notes? }
//   POST   /admin/shop/backorders/:id/clear   — body: { notes? }
//
//   GET    /admin/shop/sku-substitutes?primary_sku=...
//   POST   /admin/shop/sku-substitutes        — body: {primary,alt,priority?,notes?}
//   PATCH  /admin/shop/sku-substitutes/:id    — body: {priority?,active?,notes?}
//   DELETE /admin/shop/sku-substitutes/:id

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type SubstituteUpdate =
  Database["resupply"]["Tables"]["shop_sku_substitutes"]["Update"];

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const SKU = /^[A-Za-z0-9_-]{1,64}$/;

const markBody = z
  .object({
    sku: z.string().regex(SKU, "invalid sku shape"),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

const clearBody = z
  .object({
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

const substituteCreateBody = z
  .object({
    primarySku: z.string().regex(SKU),
    alternativeSku: z.string().regex(SKU),
    priority: z.number().int().min(1).max(1000).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.primarySku !== b.alternativeSku, {
    message: "primary_sku and alternative_sku must differ",
  });

const substitutePatchBody = z
  .object({
    priority: z.number().int().min(1).max(1000).optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

// ────────────────────────────────────────────────────────────────
// Backorders
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/shop/backorders",
  requireAdmin,
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_backorders")
      .select(
        "id, sku, marked_at, cleared_at, notes, marked_by_user_id, created_at",
      )
      .order("cleared_at", { ascending: false, nullsFirst: true })
      .order("marked_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      backorders: (data ?? []).map((r) => ({
        id: r.id,
        sku: r.sku,
        markedAt: r.marked_at,
        clearedAt: r.cleared_at,
        notes: r.notes,
        markedByUserId: r.marked_by_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/shop/backorders",
  requireAdmin,
  async (req, res) => {
    const parsed = markBody.safeParse(req.body);
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
      .from("shop_backorders")
      .insert({
        sku: parsed.data.sku,
        notes: parsed.data.notes ?? null,
        marked_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "already_backordered",
          message: `${parsed.data.sku} is already marked backordered.`,
        });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "resupply.backorder.marked",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_backorders",
      targetId: row.id,
      metadata: { sku: parsed.data.sku },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "resupply.backorder.marked audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.post(
  "/admin/shop/backorders/:id/clear",
  requireAdmin,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = clearBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("shop_backorders")
      .select("id, sku, cleared_at, notes")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.cleared_at != null) {
      res.status(409).json({
        error: "already_cleared",
        message: "This backorder row is already cleared.",
      });
      return;
    }
    const nowIso = new Date().toISOString();
    const mergedNotes = parsed.data.notes
      ? row.notes
        ? `${row.notes}\n— cleared: ${parsed.data.notes}`
        : `cleared: ${parsed.data.notes}`
      : row.notes;
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("shop_backorders")
      .update({ cleared_at: nowIso, notes: mergedNotes })
      .eq("id", row.id);
    if (updErr) throw updErr;
    await logAudit({
      action: "resupply.backorder.cleared",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_backorders",
      targetId: row.id,
      metadata: { sku: row.sku },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "resupply.backorder.cleared audit failed");
    });
    res.json({ ok: true });
  },
);

// ────────────────────────────────────────────────────────────────
// SKU substitutes (admin-only writes)
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/shop/sku-substitutes",
  requireAdmin,
  async (req, res) => {
    const primary = req.query.primary_sku;
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("shop_sku_substitutes")
      .select(
        "id, primary_sku, alternative_sku, priority, active, notes, created_at, updated_at",
      )
      .order("primary_sku", { ascending: true })
      .order("priority", { ascending: true })
      .limit(500);
    if (typeof primary === "string" && primary.length > 0) {
      if (!SKU.test(primary)) {
        res.status(400).json({ error: "invalid_primary_sku" });
        return;
      }
      query = query.eq("primary_sku", primary);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      substitutes: (data ?? []).map((r) => ({
        id: r.id,
        primarySku: r.primary_sku,
        alternativeSku: r.alternative_sku,
        priority: r.priority,
        active: r.active,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/admin/shop/sku-substitutes",
  requireAdminOnly,
  async (req, res) => {
    const parsed = substituteCreateBody.safeParse(req.body);
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
      .from("shop_sku_substitutes")
      .insert({
        primary_sku: parsed.data.primarySku,
        alternative_sku: parsed.data.alternativeSku,
        priority: parsed.data.priority ?? 100,
        notes: parsed.data.notes ?? null,
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "duplicate_pair",
          message:
            "An entry for this (primary, alternative) pair already exists.",
        });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "resupply.substitute.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_sku_substitutes",
      targetId: row.id,
      metadata: {
        primary_sku: parsed.data.primarySku,
        alternative_sku: parsed.data.alternativeSku,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "resupply.substitute.created audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/shop/sku-substitutes/:id",
  requireAdminOnly,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = substitutePatchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const update: SubstituteUpdate = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.priority != null) update.priority = parsed.data.priority;
    if (parsed.data.active != null) update.active = parsed.data.active;
    if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("shop_sku_substitutes")
      .update(update)
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

router.delete(
  "/admin/shop/sku-substitutes/:id",
  requireAdminOnly,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("shop_sku_substitutes")
      .delete()
      .eq("id", params.data.id);
    if (error) throw error;
    await logAudit({
      action: "resupply.substitute.deleted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_sku_substitutes",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "resupply.substitute.deleted audit failed");
    });
    res.json({ ok: true });
  },
);

export default router;
