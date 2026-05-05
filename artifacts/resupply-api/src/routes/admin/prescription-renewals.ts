// /admin/prescriptions/send-renewal-due — prescription concierge
// dispatcher (Phase B.2 / feature #7).
//
//   POST /admin/prescriptions/send-renewal-due
//
// Scans active prescriptions whose `valid_until` falls inside the
// renewal window (default: next 30 days), filters out rows we've
// already nudged, and emails the patient asking them to coordinate
// renewal with their prescribing physician. The single biggest
// friction point in CPAP reordering is patients getting blindsided
// by an expired Rx — Aeroflow built its entire brand on removing
// this friction and reports a 15-20% reorder-rate lift.
//
// Mirrors the abandoned-carts dispatcher: synchronous response,
// cap=50, summary counts only. Deployer wires a daily pg-boss cron
// that POSTs here OR a CSR clicks "Run now" from /admin/operations.
//
// PHI / log posture: patient name + email are required by SendGrid
// for the actual send. The audit envelope records prescription_id +
// patient_id + days_until_expiry only — never the prescriber's
// notes blob, never the SKU label (some SKUs are diagnosis-revealing).

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patients, prescriptions } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** How far before expiry the renewal nudge fires. Industry default
 *  is 30 days — long enough for a physician callback, short enough
 *  that the patient feels the urgency. */
const RENEWAL_WINDOW_DAYS = 30;
/** Per-run cap to keep the dispatcher response time bounded. The
 *  pg-boss cron / "Run now" button can re-fire if `remaining > 0`. */
const PER_RUN_CAP = 50;

router.post(
  "/admin/prescriptions/send-renewal-due",
  requireAdmin,
  async (req, res) => {
    const db = drizzle(getDbPool());
    const now = new Date();
    const cutoff = new Date(
      now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    // Joined fetch: prescription + patient identity. The dispatcher
    // index (prescriptions_renewal_eligible_idx) covers the WHERE.
    // Cast valid_until (date) → timestamptz for comparison with our
    // 30-day cutoff.
    const rows = await db
      .select({
        prescriptionId: prescriptions.id,
        patientId: prescriptions.patientId,
        validUntil: prescriptions.validUntil,
        firstName: patients.legalFirstName,
        email: patients.email,
      })
      .from(prescriptions)
      .innerJoin(patients, eq(patients.id, prescriptions.patientId))
      .where(
        and(
          eq(prescriptions.status, "active"),
          isNull(prescriptions.renewalRequestedAt),
          sql`${prescriptions.validUntil} IS NOT NULL`,
          sql`${prescriptions.validUntil}::timestamptz <= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(prescriptions.validUntil))
      .limit(PER_RUN_CAP * 4);

    let sg: ReturnType<typeof createSendgridClient>;
    try {
      sg = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        res.status(503).json({
          error: "email_not_configured",
          message: "SendGrid is not configured on this server.",
        });
        return;
      }
      throw err;
    }

    let attempted = 0;
    let sent = 0;
    let failed = 0;
    let skippedNoEmail = 0;

    for (const row of rows) {
      if (attempted >= PER_RUN_CAP) break;
      if (!row.email) {
        skippedNoEmail++;
        continue;
      }
      attempted++;
      const validUntil = row.validUntil ? new Date(row.validUntil) : null;
      // Days remaining; clamp to >=0 so an Rx that JUST expired still
      // gets the courtesy nudge (CSR-discoverable in the audit log).
      const daysUntilExpiry = validUntil
        ? Math.max(
            0,
            Math.ceil(
              (validUntil.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
            ),
          )
        : 0;

      const greeting = row.firstName
        ? `Hi ${row.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? ""}`
        : "Hi";
      try {
        await sg.sendEmail({
          to: row.email,
          subject:
            daysUntilExpiry === 0
              ? "Your CPAP prescription has expired"
              : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`,
          text: textBody(greeting, daysUntilExpiry),
          html: htmlBody(greeting, daysUntilExpiry),
          customArgs: {
            kind: "prescription_renewal_request",
            prescription_id: row.prescriptionId,
            days_until_expiry: String(daysUntilExpiry),
          },
        });

        // Stamp on success only. SendGrid 5xx leaves the row eligible
        // for the next dispatcher run.
        await db
          .update(prescriptions)
          .set({ renewalRequestedAt: now, updatedAt: now })
          .where(
            and(
              eq(prescriptions.id, row.prescriptionId),
              isNull(prescriptions.renewalRequestedAt),
            ),
          );

        await logAudit({
          action: "prescription.renewal_requested",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "prescriptions",
          targetId: row.prescriptionId,
          metadata: {
            channel: "email",
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        }).catch((err) => {
          logger.warn(
            { err },
            "prescription.renewal_requested audit write failed",
          );
        });

        sent++;
      } catch (err) {
        failed++;
        logger.warn(
          {
            err,
            prescription_id: row.prescriptionId,
            patient_id: row.patientId,
          },
          "Rx renewal request send failed",
        );
      }
    }

    res.json({
      attempted,
      sent,
      failed,
      skippedNoEmail,
      remaining: rows.length > attempted ? rows.length - attempted : 0,
      windowDays: RENEWAL_WINDOW_DAYS,
    });
  },
);

function textBody(greeting: string, daysUntilExpiry: number): string {
  const headline =
    daysUntilExpiry === 0
      ? `Your CPAP prescription has just expired.`
      : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}.`;
  return `${greeting},\n\n${headline}\n\nWe need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.\n\nIf you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.\n\n— Penn Home Medical Supply\n`;
}

function htmlBody(greeting: string, daysUntilExpiry: number): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const headline =
    daysUntilExpiry === 0
      ? `Your CPAP prescription has just expired.`
      : `Your CPAP prescription expires in <strong>${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}</strong>.`;
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${safeGreeting},</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${headline}</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Penn Home Medical Supply</p>
    </td></tr>
  </table>
</body></html>`;
}

export default router;
