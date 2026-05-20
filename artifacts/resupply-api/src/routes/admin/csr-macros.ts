// /admin/csr-macros — CRUD for the canned-reply library.
//
//   GET    /admin/csr-macros              — list (active by default)
//   POST   /admin/csr-macros              — create
//   PATCH  /admin/csr-macros/:id          — update
//   DELETE /admin/csr-macros/:id          — soft-delete (is_active=false)
//
// Same routes are NOT exposed to non-admin callers. The reply
// composer reads through the admin-gated GET; all CSRs are admins
// in this codebase, so a separate "public" read isn't needed.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin, requirePermission } from "../../middlewares/requireAdmin";

type CsrMacroUpdate = Database["resupply"]["Tables"]["csr_macros"]["Update"];

const router: IRouter = Router();

const channelSchema = z.enum(["sms", "email"]);
const channelsSchema = z.array(channelSchema).min(1).max(2);

const createBody = z
  .object({
    key: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        "lower-case alphanumerics, dash, underscore",
      ),
    label: z.string().trim().min(1).max(120),
    category: z.string().trim().max(60).optional().nullable(),
    body: z.string().trim().min(1).max(4000),
    channels: channelsSchema,
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const patchBody = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().max(60).nullable().optional(),
    body: z.string().trim().min(1).max(4000).optional(),
    channels: channelsSchema.optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

interface CsrMacroRow {
  id: string;
  key: string;
  label: string;
  category: string | null;
  body: string;
  channels: unknown;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

router.get("/admin/csr-macros", requireAdmin, async (req, res) => {
  const includeInactive = req.query.includeInactive === "1";
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("csr_macros")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true })
    .limit(500);
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }
  res.json({ macros: (data ?? []).map(serialize) });
});

router.post(
  "/admin/csr-macros",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "csr_macros.create", preset: "mutation" }),
  async (req, res) => {
  const parsed = createBody.safeParse(req.body);
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
  const adminId = req.adminUserId ?? null;
  const { data: inserted, error } = await supabase
    .schema("resupply")
    .from("csr_macros")
    .insert({
      key: parsed.data.key,
      label: parsed.data.label,
      category: parsed.data.category ?? null,
      body: parsed.data.body,
      channels: parsed.data.channels,
      sort_order: parsed.data.sortOrder ?? 100,
      created_by: adminId,
      updated_by: adminId,
    })
    .select("*")
    .single();
  if (error) {
    // 23505 unique_violation on the (key) UNIQUE index.
    if (error.code === "23505") {
      res.status(409).json({ error: "key_already_exists" });
      return;
    }
    throw error;
  }
  res.status(201).json({ macro: serialize(inserted) });
});

router.patch(
  "/admin/csr-macros/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "csr_macros.update", preset: "mutation" }),
  async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
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
  const supabase = getSupabaseServiceRoleClient();
  const adminId = req.adminUserId ?? null;
  // Build the update record translating camelCase request keys to
  // snake_case columns.
  const updateRow: CsrMacroUpdate = {
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.label !== undefined) updateRow.label = parsed.data.label;
  if (parsed.data.category !== undefined) updateRow.category = parsed.data.category;
  if (parsed.data.body !== undefined) updateRow.body = parsed.data.body;
  if (parsed.data.channels !== undefined) updateRow.channels = parsed.data.channels as Database["resupply"]["Tables"]["csr_macros"]["Row"]["channels"];
  if (parsed.data.sortOrder !== undefined) updateRow.sort_order = parsed.data.sortOrder;
  if (parsed.data.isActive !== undefined) updateRow.is_active = parsed.data.isActive;

  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("csr_macros")
    .update(updateRow)
    .eq("id", id)
    .select("*");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    res.status(404).json({ error: "macro_not_found" });
    return;
  }
  res.json({ macro: serialize(updated[0]!) });
});

router.delete(
  "/admin/csr-macros/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "csr_macros.delete", preset: "destroy" }),
  async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  // Soft-delete: keep the row for audit + analytics, just hide from
  // the picker. Callers who really want to purge can DELETE again
  // with ?hard=1 (admin-only escape hatch).
  const hard = req.query.hard === "1";
  const supabase = getSupabaseServiceRoleClient();
  if (hard) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("csr_macros")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "macro_not_found" });
      return;
    }
    res.json({ ok: true, hardDeleted: true });
    return;
  }
  const adminId = req.adminUserId ?? null;
  const { data, error } = await supabase
    .schema("resupply")
    .from("csr_macros")
    .update({
      is_active: false,
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("is_active", true)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    res.status(404).json({ error: "macro_not_found_or_already_inactive" });
    return;
  }
  res.json({ ok: true, hardDeleted: false });
});

function serialize(row: CsrMacroRow) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    category: row.category,
    body: row.body,
    channels: row.channels,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

export default router;
