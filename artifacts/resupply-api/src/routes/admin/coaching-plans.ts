// /admin/coaching-plans — patient adherence coaching workflow.
//
//   GET    /admin/coaching-plans                  — open + recent
//                                                    closed plans
//   POST   /admin/coaching-plans                  — open a plan
//   PATCH  /admin/coaching-plans/:id              — narrow updates
//                                                    + state moves
//
// Routes are requireAdmin-gated. Coaching is CSR day-to-day; the
// granular role catalog doesn't distinguish further today.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  canTransition,
  isTerminal,
  type CoachingStatus,
} from "../../lib/coaching/transitions";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

type CoachingUpdate =
  Database["resupply"]["Tables"]["patient_coaching_plans"]["Update"];

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    patientId: z.string().uuid(),
    sourceAlertId: z.string().uuid().nullable().optional(),
    targetCompliancePct: z.number().int().min(0).max(100).optional(),
    targetDate: z.string().datetime().nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z
      .enum([
        "open",
        "outreach_made",
        "improving",
        "escalated",
        "resolved",
        "abandoned",
      ])
      .optional(),
    targetCompliancePct: z.number().int().min(0).max(100).optional(),
    targetDate: z.string().datetime().nullable().optional(),
    latestCompliancePct: z.number().min(0).max(100).nullable().optional(),
    latestOutreachAt: z.string().datetime().nullable().optional(),
    resolutionNote: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/coaching-plans",
  requireAdmin,
  async (req, res) => {
    const showClosed = req.query.include === "closed";
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .select(
        "id, patient_id, source_alert_id, opened_by_user_id, status, target_compliance_pct, latest_compliance_pct, target_date, latest_outreach_at, resolution_note, opened_at, closed_at, created_at, updated_at",
      )
      .order("opened_at", { ascending: false })
      .limit(200);
    if (!showClosed) {
      query = query.is("closed_at", null);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      plans: (data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        sourceAlertId: r.source_alert_id,
        openedByUserId: r.opened_by_user_id,
        status: r.status,
        targetCompliancePct: r.target_compliance_pct,
        latestCompliancePct: r.latest_compliance_pct,
        targetDate: r.target_date,
        latestOutreachAt: r.latest_outreach_at,
        resolutionNote: r.resolution_note,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
      })),
    });
  },
);

router.post(
  "/admin/coaching-plans",
  requireAdmin,
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
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .insert({
        patient_id: parsed.data.patientId,
        source_alert_id: parsed.data.sourceAlertId ?? null,
        opened_by_user_id: req.adminUserId ?? null,
        status: "open",
        target_compliance_pct: parsed.data.targetCompliancePct ?? 70,
        target_date: parsed.data.targetDate ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    // Auto-link side-effect (Phase 6): when the plan is opened
    // FROM an existing alert, snooze that alert for 30 days so
    // it doesn't keep pestering the CSR while there's an active
    // coaching plan in flight. Best-effort — a failure here does
    // not block the plan creation.
    if (parsed.data.sourceAlertId) {
      const snoozeUntil = new Date();
      snoozeUntil.setUTCDate(snoozeUntil.getUTCDate() + 30);
      const { error: alertErr } = await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .update({
          status: "snoozed",
          snoozed_until: snoozeUntil.toISOString(),
        })
        .eq("id", parsed.data.sourceAlertId)
        .eq("status", "open");
      if (alertErr) {
        logger.warn(
          { err: alertErr, alertId: parsed.data.sourceAlertId },
          "coaching.plan.opened: auto-snooze of source alert failed",
        );
      }
    }

    await logAudit({
      action: "coaching.plan.opened",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_coaching_plans",
      targetId: row.id,
      metadata: {
        patient_id: parsed.data.patientId,
        target_compliance_pct: parsed.data.targetCompliancePct ?? 70,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "coaching.plan.opened audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/coaching-plans/:id",
  requireAdmin,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: prior, error: priorErr } = await supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .select("id, status, patient_id")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (!prior) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const update: CoachingUpdate = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.status != null) {
      const t = canTransition({
        from: prior.status as CoachingStatus,
        to: parsed.data.status,
      });
      if (!t.ok) {
        res.status(409).json({
          error: t.reason,
          message:
            t.reason === "terminal"
              ? "This plan is already closed."
              : `Illegal transition from ${prior.status} to ${parsed.data.status}.`,
        });
        return;
      }
      update.status = parsed.data.status;
      if (isTerminal(parsed.data.status)) {
        update.closed_at = new Date().toISOString();
      }
    }
    if (parsed.data.targetCompliancePct != null) {
      update.target_compliance_pct = parsed.data.targetCompliancePct;
    }
    if (parsed.data.targetDate !== undefined) {
      update.target_date = parsed.data.targetDate;
    }
    if (parsed.data.latestCompliancePct !== undefined) {
      update.latest_compliance_pct =
        parsed.data.latestCompliancePct == null
          ? null
          : parsed.data.latestCompliancePct.toString();
    }
    if (parsed.data.latestOutreachAt !== undefined) {
      update.latest_outreach_at = parsed.data.latestOutreachAt;
    }
    if (parsed.data.resolutionNote !== undefined) {
      update.resolution_note = parsed.data.resolutionNote;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .update(update)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    if (parsed.data.status && parsed.data.status !== prior.status) {
      await logAudit({
        action: "coaching.plan.transitioned",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patient_coaching_plans",
        targetId: params.data.id,
        metadata: {
          patient_id: prior.patient_id,
          from: prior.status,
          to: parsed.data.status,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "coaching.plan.transitioned audit failed",
        );
      });
    }

    res.json({ ok: true });
  },
);

export default router;
