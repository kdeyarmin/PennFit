// Patient AR collections worklist (migration 0458).
//
//   GET   /admin/billing/collections-worklist   — active/paused dunning runs
//   POST  /admin/billing/collections/:id/pause   — manual hold (dispute, etc.)
//   POST  /admin/billing/collections/:id/resolve — written off / paid by hand
//   POST  /admin/billing/collections/:id/cancel  — stop dunning this balance
//   GET   /admin/billing/collections/agency-export — CSV of agency-step runs
//
// Gated behind the collections.dunning flag (agency-export additionally behind
// collections.agency_export). reports.read to view; patients.update to manage.
// PHI: amounts + reason codes only — no message bodies.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/billing/collections-worklist",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("collections.dunning", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
      .from("patient_dunning_runs")
      .select(
        "id, patient_id, opened_balance_cents, current_step, next_action_at, status, paused_reason, opened_on, last_step_at",
      )
      .in("status", ["active", "paused"])
      .order("opened_balance_cents", { ascending: false })
      .limit(500);
    const items = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      opened_balance_cents: number;
      current_step: string;
      next_action_at: string | null;
      status: string;
      paused_reason: string | null;
      opened_on: string;
      last_step_at: string | null;
    }>;
    res.json({
      items,
      counts: {
        total: items.length,
        active: items.filter((i) => i.status === "active").length,
        paused: items.filter((i) => i.status === "paused").length,
        atAgency: items.filter((i) => i.current_step === "agency").length,
        totalBalanceCents: items.reduce(
          (s, i) => s + (i.opened_balance_cents ?? 0),
          0,
        ),
      },
    });
  },
);

const idParams = z.object({ id: z.string().uuid() });

async function transition(
  req: Request,
  res: Response,
  action: "pause" | "resolve" | "cancel",
): Promise<void> {
  const p = idParams.safeParse(req.params);
  if (!p.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  if (!(await isFeatureEnabled("collections.dunning", orgId))) {
    res.status(404).json({ error: "feature_disabled" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const update: Database["resupply"]["Tables"]["patient_dunning_runs"]["Update"] =
    { updated_at: new Date().toISOString(), next_action_at: null };
  if (action === "pause") {
    update.status = "paused";
    update.paused_reason = "manual_hold";
  } else if (action === "resolve") {
    update.status = "resolved";
    update.resolved_reason = "written_off";
  } else {
    update.status = "cancelled";
  }
  const { error } = await supabase
    .from("patient_dunning_runs")
    .update(update)
    .eq("id", p.data.id);
  if (error) throw error;

  await supabase.from("patient_dunning_events").insert({
    run_id: p.data.id,
    step: "statement",
    channel: "none",
    outcome: action === "resolve" ? "resolved" : "paused",
    detail: `manual_${action}`,
    actor_email: req.adminEmail ?? null,
  });

  await logAudit({
    action: `dunning.${action}`,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "patient_dunning_runs",
    targetId: p.data.id,
    metadata: { action },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) =>
    logger.warn({ err }, `dunning.${action} audit write failed`),
  );

  res.json({ ok: true });
}

router.post(
  "/admin/billing/collections/:id/pause",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.pause", preset: "mutation" }),
  (req, res) => void transition(req, res, "pause"),
);
router.post(
  "/admin/billing/collections/:id/resolve",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.resolve", preset: "mutation" }),
  (req, res) => void transition(req, res, "resolve"),
);
router.post(
  "/admin/billing/collections/:id/cancel",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dunning.cancel", preset: "mutation" }),
  (req, res) => void transition(req, res, "cancel"),
);

// CSV export of agency-step runs for a collections agency. Formula-injection
// guarded. Separately flag-gated — nothing leaves the building automatically.
function csvCell(value: string): string {
  const needsGuard = /^[=+\-@]/.test(value);
  const safe = needsGuard ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get(
  "/admin/billing/collections/agency-export",
  requirePermission("patients.update"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (
      !(await isFeatureEnabled("collections.dunning", orgId)) ||
      !(await isFeatureEnabled("collections.agency_export", orgId))
    ) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
      .from("patient_dunning_runs")
      .select("id, patient_id, opened_balance_cents, opened_on, last_step_at")
      .eq("status", "active")
      .eq("current_step", "agency")
      .order("opened_balance_cents", { ascending: false })
      .limit(2000);
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      opened_balance_cents: number;
      opened_on: string;
      last_step_at: string | null;
    }>;
    const header = [
      "run_id",
      "patient_id",
      "balance_usd",
      "opened_on",
      "last_contact",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.patient_id,
          (r.opened_balance_cents / 100).toFixed(2),
          r.opened_on,
          r.last_step_at ?? "",
        ]
          .map((v) => csvCell(String(v)))
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="collections-agency-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(lines.join("\r\n"));
  },
);

export default router;
