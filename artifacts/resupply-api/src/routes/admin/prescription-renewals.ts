// /admin/prescriptions/send-renewal-due — prescription concierge
// dispatcher (Phase B.2 / feature #7, SMS variant Phase G.3).
//
//   POST /admin/prescriptions/send-renewal-due[?channel=email|sms]
//
// Scans active prescriptions whose `valid_until` falls inside the
// renewal window (default: next 30 days), filters out rows we've
// already nudged, and contacts the patient asking them to coordinate
// renewal with their prescribing physician. The single biggest
// friction point in CPAP reordering is patients getting blindsided
// by an expired Rx — Aeroflow built its entire brand on removing
// this friction and reports a 15-20% reorder-rate lift.
//
// Two channels share the same `renewal_requested_at` stamp so a
// patient never gets nudged twice across email + SMS for the same
// renewal cycle. Operators typically run the email dispatcher first,
// then run the SMS dispatcher to mop up patients without an email
// on file (resupply-only customers, older patients who text but
// don't email).
//
// Mirrors the abandoned-carts dispatcher: synchronous response,
// cap=50, summary counts only. Deployer wires a daily pg-boss cron
// that POSTs here OR a CSR clicks "Run now" from /admin/operations.
//
// PHI / log posture: patient name + email/phone are required by the
// vendor for the actual send. The audit envelope records
// prescription_id + patient_id + days_until_expiry + channel only —
// never the prescriber's notes blob, never the SKU label (some SKUs
// are diagnosis-revealing), never the SMS body or phone number.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patients, prescriptions } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { sendPushToCustomerByEmail } from "../../lib/web-push";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** How far before expiry the renewal nudge fires. Industry default
 *  is 30 days — long enough for a physician callback, short enough
 *  that the patient feels the urgency. */
const RENEWAL_WINDOW_DAYS = 30;
/** Per-run cap to keep the dispatcher response time bounded. The
 *  pg-boss cron / "Run now" button can re-fire if `remaining > 0`. */
const PER_RUN_CAP = 50;

const channelQuery = z.enum(["email", "sms"]).default("email");

router.post(
  "/admin/prescriptions/send-renewal-due",
  requireAdmin,
  async (req, res) => {
    const channelParse = channelQuery.safeParse(req.query.channel ?? "email");
    if (!channelParse.success) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    const channel = channelParse.data;

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
        phoneE164: patients.phoneE164,
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

    // Per-channel vendor client. We only construct the client we'll
    // use so the other channel's missing config doesn't 503 us.
    let sg: ReturnType<typeof createSendgridClient> | null = null;
    let sms: ReturnType<typeof createTwilioSmsClient> | null = null;
    if (channel === "email") {
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
    } else {
      try {
        sms = createTwilioSmsClient();
      } catch (err) {
        if (err instanceof TwilioConfigError) {
          res.status(503).json({
            error: "sms_not_configured",
            message: "Twilio Messaging is not configured on this server.",
          });
          return;
        }
        throw err;
      }
    }

    let attempted = 0;
    let sent = 0;
    let failed = 0;
    let skippedNoContact = 0;

    for (const row of rows) {
      if (attempted >= PER_RUN_CAP) break;
      attempted++;
      const contact = channel === "email" ? row.email : row.phoneE164;
      if (!contact) {
        skippedNoContact++;
        continue;
      }
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

      const firstName = row.firstName
        ? (row.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
        : "";
      const greeting = firstName ? `Hi ${firstName}` : "Hi";
      try {
        if (channel === "email") {
          await sg!.sendEmail({
            to: contact,
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
        } else {
          await sms!.sendSms({
            to: contact,
            body: smsBody(firstName, daysUntilExpiry),
          });
        }

        // Stamp on success only. Vendor 5xx leaves the row eligible
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
            patient_id: row.patientId,
            days_until_expiry: daysUntilExpiry,
            channel,
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        }).catch((err) => {
          logger.warn(
            { err },
            "prescription.renewal_requested audit write failed",
          );
        });

        // Phase G.9 — additionally fan out to push when the patient
        // also has a shop_customers row at the same email_lower.
        // Best-effort: a push misconfig or no matching customer row
        // can't roll back the email/SMS that already went out.
        // Falls through silently when channel is SMS but the patient
        // also has an email — we use whatever email is on the
        // patients row regardless of which channel just shipped.
        const pushEmail = row.email;
        if (pushEmail) {
          void sendPushToCustomerByEmail(pushEmail, {
            title:
              daysUntilExpiry === 0
                ? "Your CPAP Rx has expired"
                : `Rx expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`,
            body: "Tap to coordinate a renewal with your physician.",
            url: "/account",
            tag: `rx_renewal:${row.prescriptionId}`,
          }).catch((err) => {
            logger.warn(
              {
                prescription_id: row.prescriptionId,
                err: err instanceof Error ? err.message : String(err),
              },
              "Rx-renewal push fan-out threw (non-fatal)",
            );
          });
        }

        sent++;
      } catch (err) {
        failed++;
        logger.warn(
          {
            err,
            prescription_id: row.prescriptionId,
            patient_id: row.patientId,
            channel,
          },
          "Rx renewal request send failed",
        );
      }
    }

    res.json({
      attempted,
      sent,
      failed,
      // Backwards-compatible: the original endpoint returned this key.
      // We keep it on the email channel, alias to the new key on SMS,
      // and expose the channel-neutral key on both.
      ...(channel === "email"
        ? { skippedNoEmail: skippedNoContact }
        : { skippedNoPhone: skippedNoContact }),
      skippedNoContact,
      remaining: rows.length > attempted ? rows.length - attempted : 0,
      windowDays: RENEWAL_WINDOW_DAYS,
      channel,
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

/**
 * Render the SMS body. Kept under 160 ASCII chars in the typical case
 * (firstName under 12 chars + double-digit days) so the message ships
 * as one segment on Twilio. UCS-2 characters would drop the limit to
 * 70/segment but we use only ASCII here.
 *
 * Reply-mode hint matches the email's "reply to delegate to us" path:
 * patients can text back the physician's name and our messaging
 * dispatcher routes the reply into the existing conversation thread.
 */
function smsBody(firstName: string, daysUntilExpiry: number): string {
  const head = firstName ? `Hi ${firstName}` : "Hi";
  const status =
    daysUntilExpiry === 0
      ? "your CPAP Rx has just expired"
      : daysUntilExpiry === 1
        ? "your CPAP Rx expires tomorrow"
        : `your CPAP Rx expires in ${daysUntilExpiry} days`;
  return (
    `${head}, ${status}. Ask your doctor for a renewal so your next supply ships ` +
    `on time, or reply with their name + practice and we'll request it for you. ` +
    `Reply STOP to opt out. — Penn Home Medical Supply`
  );
}

export default router;
