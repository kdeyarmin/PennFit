// /admin/providers-pecos — read-only PECOS enrollment status by NPI.
//
//   GET /admin/providers-pecos/:npi             — read one
//   GET /admin/providers-pecos?stale=true       — list stale rows
//   POST /admin/providers-pecos/sync-now        — admin-only manual sync

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runPecosSync } from "../../worker/jobs/pecos-sync";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const npiParam = z.object({ npi: z.string().regex(/^\d{10}$/) });

router.get(
  "/admin/providers-pecos",
  // Provider enrollment lookup — same scope as the rest of the
  // patient-facing read tier.
  requirePermission("patients.read"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const stale = req.query.stale === "true";
  let query = supabase
    .schema("resupply")
    .from("providers_pecos_status")
    .select(
      "npi, enrollment_status, enrollment_type, first_approved_date, specialty_description, last_synced_at",
    )
    .order("last_synced_at", { ascending: true })
    .limit(200);
  if (stale) {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    query = query.lte("last_synced_at", cutoff);
  }
  const { data, error } = await query;
  if (error) throw error;
  res.json({ rows: data ?? [] });
});

router.get(
  "/admin/providers-pecos/:npi",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = npiParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("providers_pecos_status")
      .select("*")
      .eq("npi", parsed.data.npi)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ pecos: data });
  },
);

router.post(
  "/admin/providers-pecos/sync-now",
  requireAdminOnly,
  adminRateLimit({ name: "providers_pecos.manual_sync", preset: "bulk" }),
  async (req, res) => {
    const stats = await runPecosSync();
    await logAudit({
      action: "providers_pecos.manual_sync",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "providers_pecos_status",
      targetId: null,
      metadata: { ...stats },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "providers_pecos.manual_sync audit write failed");
    });
    res.json({ ok: true, stats });
  },
);

export default router;
