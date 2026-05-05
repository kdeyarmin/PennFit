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
// Concurrency / double-send prevention
// -------------------------------------
// Uses an atomic claim pattern (identical to the abandoned-carts and
// review-requests dispatchers). A single CTE UPDATE stamps sent_at =
// now() for up to PER_RUN_SEND_CAP eligible rows in one statement and
// RETURNS the claimed rows. Two concurrent dispatchers observe
// non-overlapping sets because FOR UPDATE SKIP LOCKED skips rows held
// by another connection. A row whose send subsequently fails is
// unclaimed (sent_at → NULL) so the next cron tick can retry it;
// the only way sent_at stays stamped is when delivery succeeded.
//
// Audit posture matches the route: every successful send writes
// `patient.smart_trigger.sent` with channel + patient_id + kind in
// metadata. Push fan-out runs after the audit on a best-effort
// basis (Phase G.8) and never rolls back the canonical email/SMS.

import { sql } from "drizzle-orm";
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
 * wiring. Copy lives in `lib/smart-triggers/renderers.ts`; this
 * dispatcher uses `subjectForKind` for the push title and the
 * channel-specific body helpers when sending.
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

  // ──────────────────────────────────────────────────────────────────
  // Atomic claim. One CTE UPDATE stamps sent_at = now() for up to
  // PER_RUN_SEND_CAP eligible rows and RETURNs their ids. Two
  // concurrent dispatchers (cron + admin "Run now") observe
  // non-overlapping sets because FOR UPDATE OF <events-table>
  // SKIP LOCKED skips rows already held by another connection.
  //
  // The channel-specific contact filter (email / phone_e164 IS NOT
  // NULL) and the patients.status = 'active' guard are applied inside
  // the CTE so we never claim a row we cannot actually dispatch.
  //
  // On send failure the row is unclaimed (sent_at → NULL) so the next
  // cron tick can retry. The only way a row stays stamped is when the
  // delivery actually succeeded.
  // ──────────────────────────────────────────────────────────────────
  const contactFilter =
    channel === "email"
      ? sql`${patients.email} IS NOT NULL`
      : sql`${patients.phoneE164} IS NOT NULL`;

  const claimedRaw = await db.execute(sql`
    WITH eligible AS (
      SELECT ${patientSmartTriggerEvents.id}
      FROM   ${patientSmartTriggerEvents}
      INNER JOIN ${patients}
             ON ${patients.id} = ${patientSmartTriggerEvents.patientId}
      WHERE  ${patientSmartTriggerEvents.sentAt} IS NULL
        AND  ${patientSmartTriggerEvents.dismissedAt} IS NULL
        AND  ${patients.status} = 'active'
        AND  ${contactFilter}
      ORDER BY ${patientSmartTriggerEvents.detectedAt} ASC
      LIMIT    ${PER_RUN_SEND_CAP}
      FOR UPDATE OF ${patientSmartTriggerEvents} SKIP LOCKED
    )
    UPDATE ${patientSmartTriggerEvents}
       SET sent_at    = now(),
           updated_at = now()
     WHERE id IN (SELECT ${patientSmartTriggerEvents.id} FROM eligible)
    RETURNING id         AS "eventId",
              patient_id AS "patientId",
              kind
  `);
  const claimed = (claimedRaw.rows ?? []) as Array<{
    eventId: string;
    patientId: string;
    kind: string;
  }>;

  if (claimed.length === 0) {
    return {
      status: "ok",
      channel,
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedNoContact: 0,
      remaining: 0,
    };
  }

  // Batch-fetch patient contact info for all claimed events.
  // Single query — never N+1.
  const patientIds = [...new Set(claimed.map((r) => r.patientId))];
  const patientRows = await db
    .select({
      id: patients.id,
      firstName: patients.legalFirstName,
      email: patients.email,
      phoneE164: patients.phoneE164,
    })
    .from(patients)
    .where(sql`${patients.id} = ANY(${patientIds})`);
  const patientMap = new Map(patientRows.map((p) => [p.id, p]));

  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    attempted++;
    const patient = patientMap.get(row.patientId);
    const contact = channel === "email" ? patient?.email : patient?.phoneE164;

    if (!contact) {
      // Defensive: contact removed between claim and dispatch. Unclaim
      // so the next run re-evaluates (patient may add contact later).
      await db.execute(sql`
        UPDATE ${patientSmartTriggerEvents}
           SET sent_at    = NULL,
               updated_at = now()
         WHERE id = ${row.eventId}
      `);
      failed++;
      logger.warn(
        { event_id: row.eventId, channel },
        "smart-trigger claimed row has no contact after batch fetch — unclaimed",
      );
      continue;
    }

    const firstName = patient?.firstName
      ? (patient.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
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

      // sent_at was already stamped by the atomic claim — no UPDATE here.

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
      if (patient?.email) {
        void sendPushToCustomerByEmail(patient.email, {
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
      // Unclaim so the next cron tick can retry.
      await db.execute(sql`
        UPDATE ${patientSmartTriggerEvents}
           SET sent_at    = NULL,
               updated_at = now()
         WHERE id = ${row.eventId}
      `);
      failed++;
      logger.warn(
        { err, event_id: row.eventId, channel },
        "smart-trigger send failed — unclaimed for retry",
      );
    }
  }

  return {
    status: "ok",
    channel,
    attempted,
    sent,
    failed,
    skippedNoContact: 0, // contact filter is applied inside the claim CTE
    remaining: claimed.length >= PER_RUN_SEND_CAP ? 1 : 0,
  };
}
