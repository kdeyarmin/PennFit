// /admin/accreditation/readiness — run + read the survey-readiness checks.
//
//   GET  /admin/accreditation/readiness                 — most recent run summary
//   GET  /admin/accreditation/readiness/runs            — last 30 runs
//   GET  /admin/accreditation/readiness/runs/:id        — findings for a run
//   POST /admin/accreditation/readiness/run-now         — admin-only manual run

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runAccreditationReadiness } from "../../lib/accreditation/readiness-engine";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/accreditation/readiness",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: run } = await supabase
      .schema("resupply")
      .from("accreditation_readiness_runs")
      .select(
        "id, started_at, completed_at, overall_status, checks_total, checks_passed, checks_warning, checks_failed",
      )
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!run) {
      res.json({ run: null, findings: [] });
      return;
    }
    const { data: findings } = await supabase
      .schema("resupply")
      .from("accreditation_readiness_findings")
      .select(
        "id, check_key, category, severity, label, detail, target_table, target_id, created_at",
      )
      .eq("run_id", run.id)
      .order("severity", { ascending: false });
    res.json({
      run: {
        id: run.id,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        overallStatus: run.overall_status,
        counts: {
          total: run.checks_total,
          passed: run.checks_passed,
          warning: run.checks_warning,
          failed: run.checks_failed,
        },
      },
      findings: (findings ?? []).map((f) => ({
        id: f.id,
        checkKey: f.check_key,
        category: f.category,
        severity: f.severity,
        label: f.label,
        detail: f.detail,
        targetTable: f.target_table,
        targetId: f.target_id,
        createdAt: f.created_at,
      })),
    });
  },
);

router.get(
  "/admin/accreditation/readiness/runs",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("accreditation_readiness_runs")
      .select(
        "id, started_at, completed_at, overall_status, checks_total, checks_passed, checks_warning, checks_failed",
      )
      .order("started_at", { ascending: false })
      .limit(30);
    res.json({ runs: data ?? [] });
  },
);

router.get(
  "/admin/accreditation/readiness/runs/:id",
  requirePermission("compliance.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: run } = await supabase
      .schema("resupply")
      .from("accreditation_readiness_runs")
      .select("*")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!run) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { data: findings } = await supabase
      .schema("resupply")
      .from("accreditation_readiness_findings")
      .select("*")
      .eq("run_id", run.id)
      .order("severity", { ascending: false });
    res.json({ run, findings: findings ?? [] });
  },
);

router.post(
  "/admin/accreditation/readiness/run-now",
  requireAdminOnly,
  adminRateLimit({
    name: "accreditation.readiness_run_now",
    preset: "bulk",
  }),
  async (req, res) => {
    const result = await runAccreditationReadiness();
    if (!result) {
      res.status(409).json({
        error: "no_organization",
        message: "configure dme_organization first",
      });
      return;
    }
    await logAudit({
      action: "accreditation_readiness.manual_run",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "accreditation_readiness_runs",
      targetId: result.runId,
      metadata: {
        overall_status: result.overallStatus,
        checks_total: result.checksTotal,
        checks_failed: result.checksFailed,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "accreditation_readiness.manual_run audit write failed",
      );
    });
    res.json({ ok: true, ...result });
  },
);

export default router;
