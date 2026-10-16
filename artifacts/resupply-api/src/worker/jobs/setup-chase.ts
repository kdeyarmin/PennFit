// Hourly chase for open new-CPAP setups.
//
// * 24h and 48h reminders on a signature link that is still unsigned.
//   The stamp is written only after a channel actually sends, and SMS
//   is skipped outside the patient's send window so the next hour can
//   try again.
// * A follow-up when the last blocker clears. If a blocker comes back,
//   the stamp is cleared so a later clear pings again.
// * The setup row completes when the machine has shipped and the
//   first-night checklist is done.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { isOutsideSmsSendWindow } from "../../lib/comm-prefs";
import {
  buildCsrOrderSigningLink,
  deliverCsrOrderInvite,
} from "../../lib/csr-order/order";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
import { loadSetupBoard, type SetupWorkItem } from "../../lib/setups/board";

const JOB = "setups.chase";
const CRON = "17 * * * *";
const BATCH = 40;
const HOUR = 60 * 60 * 1000;

export interface SetupChaseStats {
  scanned: number;
  reminded24: number;
  reminded48: number;
  blockerCleared: number;
  completed: number;
  errors: number;
}

export async function runSetupChaseForOrg(
  orgId: string,
  now = new Date(),
): Promise<SetupChaseStats> {
  const stats: SetupChaseStats = {
    scanned: 0,
    reminded24: 0,
    reminded48: 0,
    blockerCleared: 0,
    completed: 0,
    errors: 0,
  };
  if (!(await isFeatureEnabled("setups.chase", orgId))) return stats;

  const board = await loadSetupBoard(orgId, { limit: BATCH, now });
  const supabase = getOrgScopedClient(orgId);
  for (const item of board.work) {
    stats.scanned += 1;
    try {
      if (item.stage === "ready") {
        await completeSetup(supabase, item, now);
        stats.completed += 1;
        continue;
      }
      if (item.blocker === null && !item.blockerClearedNotifiedAt) {
        await pingBlockerCleared(supabase, item, now);
        stats.blockerCleared += 1;
      } else if (item.blocker && item.blockerClearedNotifiedAt) {
        await supabase
          .from("patient_setups")
          .update({
            blocker_cleared_notified_at: null,
            updated_at: now.toISOString(),
          })
          .eq("id", item.id)
          .eq("status", "open");
      }
      const reminded = await remindSignature(supabase, orgId, item, now);
      if (reminded === 24) stats.reminded24 += 1;
      if (reminded === 48) stats.reminded48 += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err: redactDbErr(err) }, "setup chase: row failed");
    }
  }
  return stats;
}

async function completeSetup(
  supabase: ReturnType<typeof getOrgScopedClient>,
  item: SetupWorkItem,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  if (!item.blockerClearedNotifiedAt) {
    await supabase.from("patient_followups").insert({
      patient_id: item.patientId,
      body: "New CPAP setup is ready. The machine shipped and the first-night checklist is done.",
      due_at: nowIso,
      created_by_email: "system:setup-chase",
    });
  }
  await supabase
    .from("patient_setups")
    .update({
      status: "completed",
      completed_at: nowIso,
      blocker_cleared_notified_at: item.blockerClearedNotifiedAt ?? nowIso,
      updated_at: nowIso,
    })
    .eq("id", item.id)
    .eq("status", "open");
}

async function pingBlockerCleared(
  supabase: ReturnType<typeof getOrgScopedClient>,
  item: SetupWorkItem,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const { error } = await supabase.from("patient_followups").insert({
    patient_id: item.patientId,
    body: "New CPAP setup has no remaining blocker.",
    due_at: nowIso,
    created_by_email: "system:setup-chase",
  });
  if (error) throw error;
  const { error: stampErr } = await supabase
    .from("patient_setups")
    .update({
      blocker_cleared_notified_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", item.id)
    .eq("status", "open")
    .is("blocker_cleared_notified_at", null);
  if (stampErr) throw stampErr;
}

async function remindSignature(
  supabase: ReturnType<typeof getOrgScopedClient>,
  orgId: string,
  item: SetupWorkItem,
  now: Date,
): Promise<24 | 48 | null> {
  const target = item.signatureTarget;
  if (!target) return null;
  const age = now.getTime() - Date.parse(target.sentAt);
  if (!Number.isFinite(age)) return null;
  const which: 24 | 48 | null =
    age >= 48 * HOUR &&
    item.signatureReminder24At &&
    !item.signatureReminder48At
      ? 48
      : age >= 24 * HOUR && !item.signatureReminder24At
        ? 24
        : null;
  if (!which) return null;

  const link = await buildCsrOrderSigningLink(
    target.id,
    target.linkVersion,
    undefined,
    orgId,
  );
  if (!link) return null;

  const smsAllowed =
    Boolean(target.phone) &&
    !isOutsideSmsSendWindow(now, {
      timezone: target.timezone ?? undefined,
    });
  const delivery = await deliverCsrOrderInvite({
    supabase,
    customerName: target.customerName,
    email: target.email,
    phone: smsAllowed ? target.phone : null,
    link,
    orderReference: target.orderReference,
    hasDocuments: target.hasDocuments,
    reminder: true,
    orderRequestId: target.id,
  });
  if (!delivery.emailSent && !delivery.smsSent) return null;

  const column =
    which === 24 ? "signature_reminder_24_at" : "signature_reminder_48_at";
  const { error } = await supabase
    .from("patient_setups")
    .update({
      [column]: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", item.id)
    .eq("status", "open")
    .is(column, null);
  if (error) throw error;
  return which;
}

export async function runSetupChaseSweep(
  now = new Date(),
): Promise<SetupChaseStats> {
  const totals: SetupChaseStats = {
    scanned: 0,
    reminded24: 0,
    reminded48: 0,
    blockerCleared: 0,
    completed: 0,
    errors: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      const stats = await runSetupChaseForOrg(orgId, now);
      totals.scanned += stats.scanned;
      totals.reminded24 += stats.reminded24;
      totals.reminded48 += stats.reminded48;
      totals.blockerCleared += stats.blockerCleared;
      totals.completed += stats.completed;
      totals.errors += stats.errors;
    },
    { jobName: JOB },
  );
  return totals;
}

export async function registerSetupChaseJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runSetupChaseSweep();
      if (stats.scanned > 0 || stats.errors > 0) {
        logger.info(
          { event: "setups.chase.completed", ...stats },
          "setups.chase: completed",
        );
      }
    } catch (err) {
      logger.error({ err: redactDbErr(err) }, "setups.chase: failed");
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
}
