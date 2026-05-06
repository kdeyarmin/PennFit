// Rx-renewal dispatcher (Phase G.15 — Phase B.2 / G.3 follow-up).
// Lifts the body of POST /admin/prescriptions/send-renewal-due out
// of its route handler so both the admin "Run now" surface AND the
// daily pg-boss cron can call the same code path.
//
// Per-channel construction: an SMS-channel run never touches
// SendGrid and vice-versa, so a missing-on-one-side env doesn't
// gate the other. Returns a tagged-union outcome so the route can
// 503 on "not_configured" while the cron logs+skips.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

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

import { logger } from "../logger";
import { sendPushToCustomerByEmail } from "../web-push";
import {
  rxRenewalHtml,
  rxRenewalPushTitle,
  rxRenewalSms,
  rxRenewalSubject,
  rxRenewalText,
} from "./renderers";

/** How far before expiry the renewal nudge fires. Industry default
 *  is 30 days — long enough for a physician callback, short enough
 *  that the patient feels the urgency. */
export const RENEWAL_WINDOW_DAYS = 30;
/** Per-run cap to keep the dispatcher response time bounded. */
export const PER_RUN_CAP = 50;

export interface RxRenewalActor {
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type RxRenewalOutcome =
  | { status: "not_configured"; channel: "email" | "sms" }
  | {
      status: "ok";
      channel: "email" | "sms";
      attempted: number;
      sent: number;
      failed: number;
      skippedNoContact: number;
      remaining: number;
      windowDays: number;
    };

export async function runRxRenewalSendDue(
  channel: "email" | "sms",
  actor: RxRenewalActor,
): Promise<RxRenewalOutcome> {
  const db = drizzle(getDbPool());
  const now = new Date();
  const cutoff = new Date(
    now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

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

  let sg: ReturnType<typeof createSendgridClient> | null = null;
  let sms: ReturnType<typeof createTwilioSmsClient> | null = null;
  if (channel === "email") {
    try {
      sg = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        return { status: "not_configured", channel };
      }
      throw err;
    }
  } else {
    try {
      sms = createTwilioSmsClient();
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        return { status: "not_configured", channel };
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
          subject: rxRenewalSubject(daysUntilExpiry),
          text: rxRenewalText(greeting, daysUntilExpiry),
          html: rxRenewalHtml(greeting, daysUntilExpiry),
          customArgs: {
            kind: "prescription_renewal_request",
            prescription_id: row.prescriptionId,
            days_until_expiry: String(daysUntilExpiry),
          },
        });
      } else {
        await sms!.sendSms({
          to: contact,
          body: rxRenewalSms(firstName, daysUntilExpiry),
        });
      }

      const markResult = await db
        .update(prescriptions)
        .set({ renewalRequestedAt: now, updatedAt: now })
        .where(
          and(
            eq(prescriptions.id, row.prescriptionId),
            isNull(prescriptions.renewalRequestedAt),
          ),
        )
        .returning({ id: prescriptions.id });
      if (!markResult[0]) {
        logger.warn(
          { prescription_id: row.prescriptionId, channel },
          "rx-renewal: send succeeded but DB mark affected 0 rows — concurrent worker likely caused a duplicate send",
        );
      }

      await logAudit({
        action: "prescription.renewal_requested",
        adminEmail: actor.adminEmail,
        adminUserId: actor.adminUserId,
        targetTable: "prescriptions",
        targetId: row.prescriptionId,
        metadata: {
          patient_id: row.patientId,
          days_until_expiry: daysUntilExpiry,
          channel,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      }).catch((err) => {
        logger.warn(
          { err },
          "prescription.renewal_requested audit write failed",
        );
      });

      // Phase G.9 — best-effort push fan-out by email lookup.
      const pushEmail = row.email;
      if (pushEmail) {
        void sendPushToCustomerByEmail(pushEmail, {
          title: rxRenewalPushTitle(daysUntilExpiry),
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

  return {
    status: "ok",
    channel,
    attempted,
    sent,
    failed,
    skippedNoContact,
    remaining: rows.length > attempted ? rows.length - attempted : 0,
    windowDays: RENEWAL_WINDOW_DAYS,
  };
}
