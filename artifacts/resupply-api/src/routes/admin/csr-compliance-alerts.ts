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

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  csrComplianceAlerts,
  getDbPool,
  patients,
  type CsrComplianceAlertStatus,
} from "@workspace/resupply-db";

import { scanCompliance } from "../../lib/compliance-scanner";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

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
    const db = drizzle(getDbPool());

    const filters = [];
    const statuses: CsrComplianceAlertStatus[] = q.status
      ? Array.isArray(q.status)
        ? q.status
        : [q.status]
      : ["open"];
    filters.push(inArray(csrComplianceAlerts.status, statuses));
    if (q.severity) {
      filters.push(eq(csrComplianceAlerts.severity, q.severity));
    }
    if (q.alertType) {
      filters.push(eq(csrComplianceAlerts.alertType, q.alertType));
    }
    if (q.sinceDays) {
      const since = new Date(Date.now() - q.sinceDays * 24 * 60 * 60 * 1000);
      filters.push(gte(csrComplianceAlerts.createdAt, since));
    }

    const rows = await db
      .select({
        id: csrComplianceAlerts.id,
        patientId: csrComplianceAlerts.patientId,
        patientFirstName: patients.legalFirstName,
        journeyId: csrComplianceAlerts.journeyId,
        alertType: csrComplianceAlerts.alertType,
        severity: csrComplianceAlerts.severity,
        summary: csrComplianceAlerts.summary,
        metricSnapshot: csrComplianceAlerts.metricSnapshot,
        status: csrComplianceAlerts.status,
        snoozedUntil: csrComplianceAlerts.snoozedUntil,
        resolvedAt: csrComplianceAlerts.resolvedAt,
        resolvedByEmail: csrComplianceAlerts.resolvedByEmail,
        resolutionNote: csrComplianceAlerts.resolutionNote,
        createdAt: csrComplianceAlerts.createdAt,
      })
      .from(csrComplianceAlerts)
      .innerJoin(patients, eq(patients.id, csrComplianceAlerts.patientId))
      .where(and(...filters))
      .orderBy(
        // Severity sort: critical (1) > warning (2) > info (3).
        sql`CASE ${csrComplianceAlerts.severity} WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END`,
        desc(csrComplianceAlerts.createdAt),
      )
      .limit(q.limit);

    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        patientId: r.patientId,
        patientFirstName: r.patientFirstName,
        journeyId: r.journeyId,
        alertType: r.alertType,
        severity: r.severity,
        summary: r.summary,
        metricSnapshot: r.metricSnapshot ?? null,
        status: r.status,
        snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedByEmail: r.resolvedByEmail ?? null,
        resolutionNote: r.resolutionNote ?? null,
        createdAt: r.createdAt.toISOString(),
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

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: csrComplianceAlerts.id,
        patientId: csrComplianceAlerts.patientId,
        status: csrComplianceAlerts.status,
      })
      .from(csrComplianceAlerts)
      .where(eq(csrComplianceAlerts.id, alertId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }

    const now = new Date();
    let nextStatus: CsrComplianceAlertStatus;
    let updates: Record<string, unknown> = { updatedAt: now };
    if (action === "resolve") {
      nextStatus = "resolved";
      updates = {
        ...updates,
        status: nextStatus,
        resolvedAt: now,
        resolvedByEmail: req.adminEmail ?? null,
        resolvedByUserId: req.adminUserId ?? null,
        resolutionNote: note ?? null,
        snoozedUntil: null,
      };
    } else if (action === "snooze") {
      nextStatus = "snoozed";
      updates = {
        ...updates,
        status: nextStatus,
        snoozedUntil: new Date(snoozeUntil!),
      };
    } else {
      // reopen — clears resolved fields and the snooze window.
      nextStatus = "open";
      updates = {
        ...updates,
        status: nextStatus,
        resolvedAt: null,
        resolvedByEmail: null,
        resolvedByUserId: null,
        resolutionNote: null,
        snoozedUntil: null,
      };
    }

    try {
      await db
        .update(csrComplianceAlerts)
        .set(updates)
        .where(eq(csrComplianceAlerts.id, alertId));
    } catch (err) {
      // Reopening can collide with the partial unique index if a new
      // open alert for the same (patient, alert_type) was already
      // created after this one was resolved. Surface a clean 409.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "another_open_alert_exists",
          message:
            "Another open alert for this patient + type already exists. " +
            "Resolve that one first or merge manually.",
        });
        return;
      }
      throw err;
    }

    await logAudit({
      action: `csr.compliance_alert.${action}`,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_compliance_alerts",
      targetId: alertId,
      metadata: {
        patient_id: row.patientId,
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

    const db = drizzle(getDbPool());
    const { patientId, severity, summary } = parsed.data;

    // Patient existence check — unknown UUIDs become a 404 instead of
    // an FK-violation 500.
    const exists = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    let inserted: { id: string }[];
    try {
      inserted = await db
        .insert(csrComplianceAlerts)
        .values({
          patientId,
          alertType: "manual",
          severity,
          summary,
        })
        .returning({ id: csrComplianceAlerts.id });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "23505"
      ) {
        res
          .status(409)
          .json({ error: "another_open_manual_alert_exists" });
        return;
      }
      throw err;
    }
    const newId = inserted[0]?.id;
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
