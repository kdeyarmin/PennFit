// Hourly chase for open new-CPAP setups.
//
// * 24h and 48h reminders on the linked signature order. Stamps belong
//   to that order and link version, and are written only after a
//   channel sends. An expired link is staff work, not another text.
// * A follow-up when the last blocker clears. If a blocker comes back,
//   the stamp is cleared so a later clear pings again.
// * The setup row completes when the machine has shipped and the
//   first-night checklist is done. Turning setups.chase off stops the
//   messages. It does not leave a finished row open.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  buildCsrOrderSigningLink,
  deliverCsrOrderInvite,
} from "../../lib/csr-order/order";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import { readSignaturePrefs } from "../../lib/setups/reminder-channels";
import {
  EXPIRED_LINK_FOLLOW_UP,
  decideSignatureChannels,
  dueSignatureReminder,
  reminderTargetChanged,
  signatureLinkExpired,
} from "../../lib/setups/reminder-policy";
import { ensureE0601PriorAuthDraft } from "../../lib/setups/kickoff";
import { loadSetupWorkPage, type SetupWorkItem } from "../../lib/setups/board";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const JOB = "setups.chase";
const CRON = "17 * * * *";
const PAGE = 50;
const MAX_PAGES = 40;

export interface SetupChaseStats {
  scanned: number;
  reminded24: number;
  reminded48: number;
  blockerCleared: number;
  completed: number;
  errors: number;
}

type OrgClient = ReturnType<typeof getOrgScopedClient>;

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
  const messagesOn = await isFeatureEnabled("setups.chase", orgId);
  const supabase = getOrgScopedClient(orgId);
  let after: { openedAt: string; id: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await loadSetupWorkPage(orgId, {
      limit: PAGE,
      after,
      now,
    });
    for (const item of batch.work) {
      stats.scanned += 1;
      try {
        await chaseOne(supabase, orgId, item, now, messagesOn, stats);
      } catch (err) {
        stats.errors += 1;
        logger.warn({ err: redactDbErr(err) }, "setup chase: row failed");
      }
    }
    if (!batch.next) return stats;
    after = batch.next;
  }
  logger.warn(
    { orgId, scanned: stats.scanned },
    "setup chase: open-setup page cap reached",
  );
  return stats;
}

async function chaseOne(
  supabase: OrgClient,
  orgId: string,
  item: SetupWorkItem,
  now: Date,
  messagesOn: boolean,
  stats: SetupChaseStats,
): Promise<void> {
  if (item.patientId && item.priorAuth === "missing") {
    await ensureE0601PriorAuthDraft({
      orgId,
      patientId: item.patientId,
    });
  }
  const current = item.signatureTarget
    ? await alignReminderTarget(supabase, item, now)
    : item;

  if (current.stage === "ready") {
    await completeSetup(supabase, current, now, messagesOn);
    stats.completed += 1;
    return;
  }
  if (current.blocker && current.blockerClearedNotifiedAt) {
    await supabase
      .from("patient_setups")
      .update({
        blocker_cleared_notified_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", current.id)
      .eq("status", "open");
  }
  if (!messagesOn) return;

  if (current.blocker === null && !current.blockerClearedNotifiedAt) {
    await pingBlockerCleared(supabase, current, now);
    stats.blockerCleared += 1;
  }
  const reminded = await remindSignature(supabase, orgId, current, now);
  if (reminded === 24) stats.reminded24 += 1;
  if (reminded === 48) stats.reminded48 += 1;
}

async function alignReminderTarget(
  supabase: OrgClient,
  item: SetupWorkItem,
  now: Date,
): Promise<SetupWorkItem> {
  const target = item.signatureTarget;
  if (
    !target ||
    !reminderTargetChanged({
      reminderOrderId: item.reminderOrderId,
      reminderLinkVersion: item.reminderLinkVersion,
      orderId: target.id,
      linkVersion: target.linkVersion,
    })
  ) {
    return item;
  }
  const { error } = await supabase
    .from("patient_setups")
    .update({
      signature_reminder_24_at: null,
      signature_reminder_48_at: null,
      reminder_order_id: target.id,
      reminder_link_version: target.linkVersion,
      updated_at: now.toISOString(),
    })
    .eq("id", item.id)
    .eq("status", "open");
  if (error) throw error;
  return {
    ...item,
    signatureReminder24At: null,
    signatureReminder48At: null,
    reminderOrderId: target.id,
    reminderLinkVersion: target.linkVersion,
  };
}

async function completeSetup(
  supabase: OrgClient,
  item: SetupWorkItem,
  now: Date,
  messagesOn: boolean,
): Promise<void> {
  const nowIso = now.toISOString();
  if (messagesOn && !item.blockerClearedNotifiedAt && item.patientId) {
    const { error } = await supabase.from("patient_followups").insert({
      patient_id: item.patientId,
      body: "New CPAP setup is ready. The machine shipped and the first-night checklist is done.",
      due_at: nowIso,
      created_by_email: "system:setup-chase",
    });
    if (error) throw error;
  }
  const { error } = await supabase
    .from("patient_setups")
    .update({
      status: "completed",
      completed_at: nowIso,
      blocker_cleared_notified_at: messagesOn
        ? (item.blockerClearedNotifiedAt ?? nowIso)
        : item.blockerClearedNotifiedAt,
      updated_at: nowIso,
    })
    .eq("id", item.id)
    .eq("status", "open");
  if (error) throw error;
}

async function pingBlockerCleared(
  supabase: OrgClient,
  item: SetupWorkItem,
  now: Date,
): Promise<void> {
  if (!item.patientId) return;
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
  supabase: OrgClient,
  orgId: string,
  item: SetupWorkItem,
  now: Date,
): Promise<24 | 48 | null> {
  const target = item.signatureTarget;
  if (!target) return null;
  if (signatureLinkExpired(target.expiresAt, now)) {
    await noteExpiredLink(supabase, item, now);
    return null;
  }
  const which = dueSignatureReminder({
    sentAt: target.sentAt,
    now,
    reminder24At: item.signatureReminder24At,
    reminder48At: item.signatureReminder48At,
  });
  if (!which) return null;

  const prefs = await readSignaturePrefs(supabase, item.patientId);
  const channels = decideSignatureChannels({
    email: target.email,
    phone: target.phone,
    explicit: prefs.explicit,
    unknown: prefs.unknown,
    prefs: prefs.prefs,
    now,
    patientTimezone: prefs.patientTimezone ?? target.timezone,
  });
  if (!channels.allowEmail && !channels.allowSms) return null;

  const link = await buildCsrOrderSigningLink(
    target.id,
    target.linkVersion,
    undefined,
    orgId,
  );
  if (!link) return null;

  const delivery = await deliverCsrOrderInvite({
    supabase,
    customerName: target.customerName,
    email: channels.allowEmail ? target.email : null,
    phone: channels.allowSms ? target.phone : null,
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
      reminder_order_id: target.id,
      reminder_link_version: target.linkVersion,
      updated_at: now.toISOString(),
    })
    .eq("id", item.id)
    .eq("status", "open")
    .is(column, null);
  if (error) throw error;
  return which;
}

async function noteExpiredLink(
  supabase: OrgClient,
  item: SetupWorkItem,
  now: Date,
): Promise<void> {
  if (!item.patientId) return;
  const { data: existing, error: readErr } = await supabase
    .from("patient_followups")
    .select("id")
    .eq("patient_id", item.patientId)
    .eq("body", EXPIRED_LINK_FOLLOW_UP)
    .is("completed_at", null)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  if (existing?.id) return;
  const { error } = await supabase.from("patient_followups").insert({
    patient_id: item.patientId,
    body: EXPIRED_LINK_FOLLOW_UP,
    due_at: now.toISOString(),
    created_by_email: "system:setup-chase",
  });
  if (error) throw error;
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
