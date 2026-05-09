// /admin/csr-compliance-alerts — CSR-facing at-risk queue (Phase
// B.1.1 / feature #17 follow-up). Surfaces rows in
// `csr_compliance_alerts` with light filtering and resolve / snooze
// transitions.
//
//   GET   /admin/csr-compliance-alerts             — list (filters)
//   POST  /admin/csr-compliance-alerts/scan-now    — kick the scanner
//   PATCH /admin/csr-compliance-alerts/:id         — resolve / snooze / reopen
//   POST  /admin/csr-compliance-alerts             — manual create
//
// PHI / log posture: alerts already store only a one-line summary +
// metric snapshot — never message bodies, never phone/email
// plaintext. The list response includes patient first name so the
// dashboard can render a useful row label.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  getSupabaseServiceRoleClient,
  type CsrComplianceAlertStatus,
  type Database,
} from "@workspace/resupply-db";

import { scanCompliance } from "../../lib/compliance-scanner";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

type CsrComplianceAlertUpdate =
  Database["resupply"]["Tables"]["csr_compliance_alerts"]["Update"];

const adminScanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_compliance_scan",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const adminCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_compliance_alert_create",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const router: IRouter = Router();

const listQuery = z
  .object({
    status: z
      .union([
        z.enum(["open", "snoozed", "resolved"]),
        z.array(z.enum(["open", "snoozed", "resolved"])),
      ])
      .optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
    alertType: z
      .enum(["low_usage", "no_response", "send_failure", "manual"])
      .optional(),
    sinceDays: z.coerce.number().int().min(1).max(365).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const SEVERITY_ORDER: Record<string, number> = {
  critical: 1,
  warning: 2,
  info: 3,
};

router.get(
  "/admin/csr-compliance-alerts",
  requireAdmin,
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const q = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const statuses: CsrComplianceAlertStatus[] = q.status
      ? Array.isArray(q.status)
        ? q.status
        : [q.status]
      : ["open"];

    let alertsQuery = supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select(
        "id, patient_id, journey_id, alert_type, severity, summary, metric_snapshot, status, snoozed_until, resolved_at, resolved_by_email, resolution_note, created_at",
      )
      .in("status", statuses)
      // The original SQL ordered by `CASE severity WHEN 'critical' THEN 1
      // WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC`. PostgREST
      // doesn't support CASE in ORDER BY, so we fetch a slightly larger
      // page (limit is bounded at 200) and re-sort JS-side.
      .order("created_at", { ascending: false })
      .limit(q.limit);
    if (q.severity) alertsQuery = alertsQuery.eq("severity", q.severity);
    if (q.alertType) alertsQuery = alertsQuery.eq("alert_type", q.alertType);
    if (q.sinceDays) {
      const sinceIso = new Date(
        Date.now() - q.sinceDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      alertsQuery = alertsQuery.gte("created_at", sinceIso);
    }
    const { data: alertRows, error: alertErr } = await alertsQuery;
    if (alertErr) throw alertErr;

    // Bulk-fetch the joined patient.legal_first_name (was an INNER JOIN).
    const patientIds = Array.from(
      new Set((alertRows ?? []).map((r) => r.patient_id)),
    );
    const patientsRes =
      patientIds.length > 0
        ? await supabase
            .schema("resupply")
            .from("patients")
            .select("id, legal_first_name")
            .in("id", patientIds)
        : { data: [], error: null as null };
    if (patientsRes.error) throw patientsRes.error;
    const firstNameByPatient = new Map<string, string | null>();
    for (const p of patientsRes.data ?? []) {
      firstNameByPatient.set(p.id, p.legal_first_name);
    }

    // Drop alerts whose patient id didn't resolve (was an INNER JOIN
    // before, so a missing patient row should not appear). Then
    // severity-then-created_at sort (critical > warning > info).
    const merged = (alertRows ?? [])
      .filter((r) => firstNameByPatient.has(r.patient_id))
      .sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity] ?? 99;
        const sb = SEVERITY_ORDER[b.severity] ?? 99;
        if (sa !== sb) return sa - sb;
        if (a.created_at !== b.created_at)
          return a.created_at < b.created_at ? 1 : -1;
        return 0;
      });

    res.json({
      alerts: merged.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        patientFirstName: firstNameByPatient.get(r.patient_id) ?? null,
        journeyId: r.journey_id,
        alertType: r.alert_type,
        severity: r.severity,
        summary: r.summary,
        metricSnapshot: r.metric_snapshot ?? null,
        status: r.status,
        snoozedUntil: r.snoozed_until,
        resolvedAt: r.resolved_at,
        resolvedByEmail: r.resolved_by_email ?? null,
        resolutionNote: r.resolution_note ?? null,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/csr-compliance-alerts/scan-now",
  requireAdmin,
  adminScanLimiter,
  async (req, res) => {
    const summary = await scanCompliance({ pool: getDbPool() });
    await logAudit({
      action: "csr.compliance_scan.run",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_compliance_alerts",
      targetId: null,
      metadata: summary as unknown as Record<string, unknown>,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "csr.compliance_scan.run audit write failed");
    });
    res.json(summary);
  },
);

const patchBody = z
  .object({
    action: z.enum(["resolve", "snooze", "reopen"]),
    /** ISO 8601 timestamp; required when action='snooze'. */
    snoozeUntil: z.string().datetime().optional(),
    /** Free-text resolution note; bounded length. */
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (b) => b.action !== "snooze" || !!b.snoozeUntil,
    { message: "snoozeUntil required when action='snooze'" },
  );

router.patch(
  "/admin/csr-compliance-alerts/:id",
  requireAdmin,
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }
    const alertId = idCheck.data;

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
    const { action, snoozeUntil, note } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select("id, patient_id, status")
      .eq("id", alertId)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    let nextStatus: CsrComplianceAlertStatus;
    const updates: CsrComplianceAlertUpdate = { updated_at: nowIso };
    if (action === "resolve") {
      nextStatus = "resolved";
      updates.status = nextStatus;
      updates.resolved_at = nowIso;
      updates.resolved_by_email = req.adminEmail ?? null;
      updates.resolved_by_user_id = req.adminUserId ?? null;
      updates.resolution_note = note ?? null;
      updates.snoozed_until = null;
    } else if (action === "snooze") {
      nextStatus = "snoozed";
      updates.status = nextStatus;
      updates.snoozed_until = snoozeUntil!;
    } else {
      // reopen — clears resolved fields and the snooze window.
      nextStatus = "open";
      updates.status = nextStatus;
      updates.resolved_at = null;
      updates.resolved_by_email = null;
      updates.resolved_by_user_id = null;
      updates.resolution_note = null;
      updates.snoozed_until = null;
    }

    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .update(updates)
      .eq("id", alertId);
    if (updateErr) {
      // Reopening can collide with the partial unique index if a new
      // open alert for the same (patient, alert_type) was already
      // created after this one was resolved. Surface a clean 409.
      if (
        updateErr &&
        typeof updateErr === "object" &&
        "code" in updateErr &&
        (updateErr as { code: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "another_open_alert_exists",
          message:
            "Another open alert for this patient + type already exists. " +
            "Resolve that one first or merge manually.",
        });
        return;
      }
      throw updateErr;
    }

    await logAudit({
      action: `csr.compliance_alert.${action}`,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_compliance_alerts",
      targetId: alertId,
      metadata: {
        patient_id: row.patient_id,
        previous_status: row.status,
        new_status: nextStatus,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err, action },
        "csr.compliance_alert audit write failed",
      );
    });

    res.json({ id: alertId, status: nextStatus });
  },
);

const createBody = z
  .object({
    patientId: z.string().uuid(),
    severity: z.enum(["info", "warning", "critical"]).default("warning"),
    summary: z.string().min(1).max(280),
  })
  .strict();

router.post(
  "/admin/csr-compliance-alerts",
  requireAdmin,
  adminCreateLimiter,
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
    const { patientId, severity, summary } = parsed.data;

    // Patient existence check — unknown UUIDs become a 404 instead of
    // an FK-violation 500.
    const { data: existsRow, error: existsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existsRow) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "manual",
        severity,
        summary,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      if (
        insertErr &&
        typeof insertErr === "object" &&
        "code" in insertErr &&
        (insertErr as { code: string }).code === "23505"
      ) {
        res
          .status(409)
          .json({ error: "another_open_manual_alert_exists" });
        return;
      }
      throw insertErr;
    }
    const newId = inserted?.id;
    if (!newId) throw new Error("insert returned no rows");

    await logAudit({
      action: "csr.compliance_alert.create_manual",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_compliance_alerts",
      targetId: newId,
      metadata: { patient_id: patientId, severity },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "csr.compliance_alert.create_manual audit write failed",
      );
    });

    res.status(201).json({ id: newId, status: "open" });
  },
);

export default router;
