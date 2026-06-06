// pg-boss job: re-send signing links for unsigned patient packets.
//
// Why this exists
// ---------------
// A patient packet is only useful once it's signed. Some patients open
// the link and drift off, or never open it at all. This sweep nudges
// them — re-issuing a fresh signing link over every channel they have
// on file (email + SMS) — on a fixed cadence, capped at a maximum
// number of reminders so we never become a nuisance.
//
// Gating
// ------
// Runtime-gated by the `patient_packets.autoremind` feature flag
// (seeded OFF in migration 0223). The cron always attaches; flipping the
// flag off pauses the sends without touching the schedule. The admin's
// per-packet "Resend" button is unaffected.
//
// Eligibility (all must hold)
//   * status is 'sent' or 'viewed' (not completed / voided / expired)
//   * not past expires_at
//   * sent at least REMIND_AFTER_DAYS ago
//   * never reminded, or last reminded at least REMIND_INTERVAL_DAYS ago
//   * fewer than MAX_REMINDERS nudges so far
//
// Each nudge bumps link_version (invalidating the prior link), refreshes
// the expiry, increments reminder_count, and stamps last_reminded_at —
// claimed with an optimistic compare-and-set so two overlapping runs
// can't double-send.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  buildPacketSigningLink,
  deliverPacketLink,
  DEFAULT_PACKET_TTL_DAYS,
  PACKET_CHANNELS,
} from "../../lib/patient-packet/send";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const REMINDER_JOB = "patient-packet.reminders";
const REMINDER_CRON = process.env.PATIENT_PACKET_REMINDER_CRON ?? "33 15 * * *";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const REMIND_AFTER_DAYS = intEnv("PATIENT_PACKET_REMIND_AFTER_DAYS", 3);
const REMIND_INTERVAL_DAYS = intEnv("PATIENT_PACKET_REMIND_INTERVAL_DAYS", 3);
const MAX_REMINDERS = intEnv("PATIENT_PACKET_MAX_REMINDERS", 3);
const BATCH = 200;

interface SweepStats {
  skipped?: boolean;
  scanned: number;
  reminded: number;
  emailSent: number;
  smsSent: number;
}

export async function runPatientPacketReminderSweep(): Promise<SweepStats> {
  if (!(await isFeatureEnabled("patient_packets.autoremind"))) {
    return { skipped: true, scanned: 0, reminded: 0, emailSent: 0, smsSent: 0 };
  }

  const supabase = getSupabaseServiceRoleClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const sentBefore = new Date(
    now - REMIND_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const remindedBefore = new Date(
    now - REMIND_INTERVAL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: candidates, error } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .select(
      "id, patient_id, link_version, reminder_count, recipient_name, recipient_email, sent_at",
    )
    .in("status", ["sent", "viewed"])
    .lt("reminder_count", MAX_REMINDERS)
    .gt("expires_at", nowIso)
    .lte("sent_at", sentBefore)
    .or(`last_reminded_at.is.null,last_reminded_at.lte.${remindedBefore}`)
    .order("sent_at", { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  const rows = candidates ?? [];
  const stats: SweepStats = {
    scanned: rows.length,
    reminded: 0,
    emailSent: 0,
    smsSent: 0,
  };
  if (rows.length === 0) return stats;

  // Bulk-resolve patient phone numbers for the SMS channel.
  const patientIds = Array.from(new Set(rows.map((r) => r.patient_id)));
  const { data: patients } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, phone_e164")
    .in("id", patientIds);
  const phoneByPatient = new Map<string, string | null>();
  for (const p of patients ?? []) phoneByPatient.set(p.id, p.phone_e164);

  for (const c of rows) {
    const nextVersion = (c.link_version ?? 1) + 1;
    const newExpiry = new Date(
      now + DEFAULT_PACKET_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Claim: compare-and-set on (reminder_count, link_version) so two
    // overlapping sweeps can't both nudge the same packet.
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update({
        link_version: nextVersion,
        status: "sent",
        sent_at: nowIso,
        expires_at: newExpiry,
        reminder_count: (c.reminder_count ?? 0) + 1,
        last_reminded_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", c.id)
      .eq("reminder_count", c.reminder_count ?? 0)
      .eq("link_version", c.link_version)
      .select("id")
      .maybeSingle();
    if (claimErr) {
      logger.warn(
        { err: claimErr, packet_id: c.id },
        "patient-packet.reminders: claim failed (non-fatal)",
      );
      continue;
    }
    if (!claimed) continue; // raced — another run took it

    const link = buildPacketSigningLink(c.id, nextVersion);
    let emailSent = false;
    let smsSent = false;
    try {
      const res = await deliverPacketLink({
        supabase,
        recipientName: c.recipient_name,
        link,
        email: c.recipient_email,
        phone: phoneByPatient.get(c.patient_id) ?? null,
        channels: PACKET_CHANNELS,
        reminder: true,
        packetId: c.id,
      });
      emailSent = res.emailSent;
      smsSent = res.smsSent;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          packet_id: c.id,
        },
        "patient-packet.reminders: delivery failed (non-fatal)",
      );
      );
    }

    stats.reminded += 1;
    if (emailSent) stats.emailSent += 1;
    if (smsSent) stats.smsSent += 1;

    await logAudit({
      action: "patient_packet.reminded",
      targetTable: "patient_packets",
      targetId: c.id,
      metadata: {
        patient_id: c.patient_id,
        reminder_count: (c.reminder_count ?? 0) + 1,
        email_sent: emailSent,
        sms_sent: smsSent,
      },
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.reminded audit write failed");
    });
  }

  return stats;
}

export async function registerPatientPacketReminderJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, REMINDER_JOB, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(REMINDER_JOB, async () => {
    try {
      const stats = await runPatientPacketReminderSweep();
      logger.info(
        { event: "patient-packet.reminders.completed", ...stats },
        "patient-packet.reminders: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patient-packet.reminders: failed",
      );
      throw err;
    }
  });

  await boss.schedule(REMINDER_JOB, REMINDER_CRON);
  logger.info({ cron: REMINDER_CRON }, "patient-packet.reminders scheduled");
}
