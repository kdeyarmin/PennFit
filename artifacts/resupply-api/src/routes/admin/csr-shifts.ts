// /admin/csr-shifts — scheduled coverage windows for CSRs.
//
//   GET   /admin/csr-shifts?from=ISO&to=ISO
//   POST  /admin/csr-shifts                — admin-only schedule
//   PATCH /admin/csr-shifts/:id            — status / notes
//   GET   /admin/csr-shifts/on-now         — who's actively on shift

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();
const idParam = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    staffUserId: z.string().min(1).max(64),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: "endsAt must be later than startsAt",
  });

// Schedule visibility — every CSR who handles the inbox wants to
// know who else is on shift. `conversations.manage` matches the
// rest of the CSR-tier coordination surface.
router.get("/admin/csr-shifts", requirePermission("conversations.manage"), async (req, res) => {
  const from =
    (typeof req.query.from === "string" && req.query.from) || undefined;
  const to = (typeof req.query.to === "string" && req.query.to) || undefined;
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("csr_shifts")
    .select(
      "id, staff_user_id, starts_at, ends_at, status, notes, created_at, updated_at",
    )
    .order("starts_at", { ascending: true })
    .limit(500);
  if (from) query = query.gte("ends_at", from);
  if (to) query = query.lte("starts_at", to);
  const { data, error } = await query;
  if (error) throw error;
  res.json({
    shifts: (data ?? []).map((r) => ({
      id: r.id,
      staffUserId: r.staff_user_id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.get(
  "/admin/csr-shifts/on-now",
  // Who's on shift right now — same CSR-visible scope.
  requirePermission("conversations.manage"),
  async (_req, res) => {
    const iso = new Date().toISOString();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("csr_shifts")
      .select("id, staff_user_id, starts_at, ends_at, status")
      .lte("starts_at", iso)
      .gt("ends_at", iso)
      .neq("status", "called_off")
      .order("starts_at", { ascending: true })
      .limit(50);
    if (error) throw error;
    res.json({
      onShift: (data ?? []).map((r) => ({
        id: r.id,
        staffUserId: r.staff_user_id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
      })),
    });
  },
);

router.post(
  "/admin/csr-shifts",
  requireAdminOnly,
  adminRateLimit({ name: "csr_shifts.create", preset: "mutation" }),
  async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("csr_shifts")
    .insert({
      staff_user_id: parsed.data.staffUserId,
      starts_at: parsed.data.startsAt,
      ends_at: parsed.data.endsAt,
      notes: parsed.data.notes ?? null,
      created_by_user_id: req.adminUserId ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  res.status(201).json({ id: row.id });
});

router.patch(
  "/admin/csr-shifts/:id",
  requireAdminOnly,
  adminRateLimit({ name: "csr_shifts.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = z
      .object({
        status: z.enum(["scheduled", "called_off", "actual"]).optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const update: {
      status?: "scheduled" | "called_off" | "actual";
      notes?: string | null;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };
    if (parsed.data.status) update.status = parsed.data.status;
    if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;
    // Read back so we distinguish "no row to update" (404) from a real
    // update (200). Without this the handler silently returned 200
    // even when the id was nonexistent.
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("csr_shifts")
      .update(update)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
