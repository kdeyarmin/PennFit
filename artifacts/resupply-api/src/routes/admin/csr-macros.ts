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
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { csrMacros, getDbPool } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

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

router.get("/admin/csr-macros", requireAdmin, async (req, res) => {
  const includeInactive = req.query.includeInactive === "1";
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(csrMacros)
    .where(includeInactive ? undefined : eq(csrMacros.isActive, true))
    .orderBy(asc(csrMacros.sortOrder), asc(csrMacros.label))
    .limit(500);
  res.json({ macros: rows.map(serialize) });
});

router.post("/admin/csr-macros", requireAdmin, async (req, res) => {
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
  const db = drizzle(getDbPool());
  const adminId = req.adminUserId ?? null;
  try {
    const inserted = await db
      .insert(csrMacros)
      .values({
        key: parsed.data.key,
        label: parsed.data.label,
        category: parsed.data.category ?? null,
        body: parsed.data.body,
        channels: parsed.data.channels,
        sortOrder: parsed.data.sortOrder ?? 100,
        createdBy: adminId,
        updatedBy: adminId,
      })
      .returning();
    res.status(201).json({ macro: serialize(inserted[0]!) });
  } catch (err) {
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
      res.status(409).json({ error: "key_already_exists" });
      return;
    }
    throw err;
  }
});

router.patch("/admin/csr-macros/:id", requireAdmin, async (req, res) => {
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
  const db = drizzle(getDbPool());
  const adminId = req.adminUserId ?? null;
  const updated = await db
    .update(csrMacros)
    .set({
      ...parsed.data,
      updatedBy: adminId,
      updatedAt: new Date(),
    })
    .where(eq(csrMacros.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "macro_not_found" });
    return;
  }
  res.json({ macro: serialize(updated[0]!) });
});

router.delete("/admin/csr-macros/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  // Soft-delete: keep the row for audit + analytics, just hide from
  // the picker. Callers who really want to purge can DELETE again
  // with ?hard=1 (admin-only escape hatch).
  const hard = req.query.hard === "1";
  const db = drizzle(getDbPool());
  if (hard) {
    const deleted = await db
      .delete(csrMacros)
      .where(eq(csrMacros.id, id))
      .returning({ id: csrMacros.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "macro_not_found" });
      return;
    }
    res.json({ ok: true, hardDeleted: true });
    return;
  }
  const adminId = req.adminUserId ?? null;
  const updated = await db
    .update(csrMacros)
    .set({ isActive: false, updatedBy: adminId, updatedAt: new Date() })
    .where(and(eq(csrMacros.id, id), eq(csrMacros.isActive, true)))
    .returning({ id: csrMacros.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "macro_not_found_or_already_inactive" });
    return;
  }
  res.json({ ok: true, hardDeleted: false });
});

function serialize(row: typeof csrMacros.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    category: row.category,
    body: row.body,
    channels: row.channels,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export default router;
