// Smart-trigger send-due dispatcher (Phase G.14 — Phase E.2 / G.7
// follow-up). Same pattern as ./evaluator.ts: lifts the body of
// POST /admin/smart-triggers/send-due out of its route handler so
// both the admin "Run now" surface AND the daily pg-boss cron can
// call the same code path.
//
// Per-channel construction: an SMS-channel run never touches
// SendGrid and vice-versa, so a missing-on-one-side env doesn't
// gate the other. Returns a tagged-union outcome so the route can
// 503 on "not_configured" while the cron logs+skips.
//
// Audit posture matches the route: every successful send writes
// `patient.smart_trigger.sent` with channel + patient_id + kind in
// metadata. Push fan-out runs after the audit on a best-effort
// basis (Phase G.8) and never rolls back the canonical email/SMS.

import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientSmartTriggerEvents,
  patients,
} from "@workspace/resupply-db";
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
import { type TriggerKind } from "./index";

/** Per-dispatcher-run cap. Same value the route uses. */
const PER_RUN_SEND_CAP = 50;

export interface DispatcherActor {
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type DispatcherOutcome =
  | { status: "not_configured"; channel: "email" | "sms" }
  | {
      status: "ok";
      channel: "email" | "sms";
      attempted: number;
      sent: number;
      failed: number;
      skippedNoContact: number;
      remaining: number;
    };

/**
 * Shared smart-trigger renderers, passed in by the caller so this
 * dispatcher stays decoupled from the renderer module and any route
 * wiring. Email subject/body copy now lives with the shared
 * renderers; this dispatcher uses `subjectForKind` for the push
 * title and the channel-specific body helpers when sending.
 */
export interface SmartTriggerRenderers {
  subjectForKind: (kind: TriggerKind) => string;
  textBody: (greeting: string, kind: TriggerKind) => string;
  htmlBody: (greeting: string, kind: TriggerKind) => string;
  smsBody: (firstName: string, kind: TriggerKind) => string;
  pushBody: (kind: TriggerKind) => string;
}

export async function runSmartTriggerSendDue(
  channel: "email" | "sms",
  actor: DispatcherActor,
  renderers: SmartTriggerRenderers,
): Promise<DispatcherOutcome> {
  const db = drizzle(getDbPool());

  const rows = await db
    .select({
      eventId: patientSmartTriggerEvents.id,
      patientId: patientSmartTriggerEvents.patientId,
      kind: patientSmartTriggerEvents.kind,
      firstName: patients.legalFirstName,
      email: patients.email,
      phoneE164: patients.phoneE164,
    })
    .from(patientSmartTriggerEvents)
    .innerJoin(patients, eq(patients.id, patientSmartTriggerEvents.patientId))
    .where(
      and(
        isNull(patientSmartTriggerEvents.sentAt),
        isNull(patientSmartTriggerEvents.dismissedAt),
      ),
    )
    .orderBy(asc(patientSmartTriggerEvents.detectedAt))
    .limit(PER_RUN_SEND_CAP * 2);

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
  const now = new Date();

  for (const row of rows) {
    if (attempted >= PER_RUN_SEND_CAP) break;
    attempted++;
    const contact = channel === "email" ? row.email : row.phoneE164;
    if (!contact) {
      skippedNoContact++;
      continue;
    }
    const firstName = row.firstName
      ? (row.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
      : "";
    const greeting = firstName ? `Hi ${firstName}` : "Hi";
    try {
      if (channel === "email") {
        await sg!.sendEmail({
          to: contact,
          subject: renderers.subjectForKind(row.kind as TriggerKind),
          text: renderers.textBody(greeting, row.kind as TriggerKind),
          html: renderers.htmlBody(greeting, row.kind as TriggerKind),
          customArgs: {
            kind: "smart_trigger",
            trigger_kind: row.kind,
            event_id: row.eventId,
          },
        });
      } else {
        await sms!.sendSms({
          to: contact,
          body: renderers.smsBody(firstName, row.kind as TriggerKind),
        });
      }

      await db
        .update(patientSmartTriggerEvents)
        .set({ sentAt: now, updatedAt: now })
        .where(
          and(
            eq(patientSmartTriggerEvents.id, row.eventId),
            isNull(patientSmartTriggerEvents.sentAt),
          ),
        );

      await logAudit({
        action: "patient.smart_trigger.sent",
        adminEmail: actor.adminEmail,
        adminUserId: actor.adminUserId,
        targetTable: "patient_smart_trigger_events",
        targetId: row.eventId,
        metadata: {
          patient_id: row.patientId,
          kind: row.kind,
          channel,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      }).catch((err) => {
        logger.warn({ err }, "patient.smart_trigger.sent audit write failed");
      });

      // Phase G.8 — best-effort push fan-out by email lookup. Never
      // rolls back the canonical email/SMS that already went out.
      if (row.email) {
        void sendPushToCustomerByEmail(row.email, {
          title: renderers.subjectForKind(row.kind as TriggerKind),
          body: renderers.pushBody(row.kind as TriggerKind),
          url: "/account/insights",
          tag: `smart_trigger:${row.eventId}`,
        }).catch((err) => {
          logger.warn(
            {
              event_id: row.eventId,
              err: err instanceof Error ? err.message : String(err),
            },
            "smart-trigger push fan-out threw (non-fatal)",
          );
        });
      }

      sent++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, event_id: row.eventId, channel },
        "smart-trigger send failed",
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
  };
}
