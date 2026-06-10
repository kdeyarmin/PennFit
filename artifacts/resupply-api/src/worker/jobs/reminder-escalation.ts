// reminders.escalation-scan — multi-channel escalation for unanswered
// resupply reminders (#7).
//
// The hourly reminders.scan does the FIRST touch on a single channel
// (sms OR email, per resolveOutreachPlan). It never follows up on a
// different channel. This job is the additive second half: a daily
// sweep that, for episodes still unresolved N days after their first
// reminder, escalates to the NEXT channel in the ladder — and once
// every channel has been tried, raises a CSR "call them" alert.
//
// Why a separate job (not surgery on reminders.scan):
//   The scan is the central, high-traffic loop. Bolting escalation
//   state into it risks the first-touch path. This job is isolated,
//   feature-flagged, and reuses the existing SEND_SMS_JOB /
//   SEND_EMAIL_JOB queues — so the actual send still runs through the
//   same dedup + business-hours-safe + audit machinery. We only decide
//   WHICH episodes get a second channel and enqueue it.
//
// Resolution signal:
//   We only consider episodes still in `outreach_pending` /
//   `awaiting_response`. The moment a patient confirms / declines (or
//   the episode is fulfilled / canceled) it leaves that set and is
//   never escalated.
//
// Quiet-hours:
//   The job is scheduled at 18:00 UTC (1pm ET / 10am PT), inside
//   9am–8pm local for every continental-US timezone, so an SMS
//   escalation can't land in a patient's quiet hours.
//
// Idempotency:
//   Escalating to a channel creates a new conversation on that channel
//   (sendReminder* does that), so the next daily run sees both channels
//   tried and stops sending. The per-day-per-channel dedup in the send
//   job prevents a double-send within a day. The CSR alert is collapsed
//   to one open row per patient by the existing partial unique index.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";
import { SEND_EMAIL_JOB, SEND_SMS_JOB } from "./reminders.js";

export const ESCALATION_JOB = "reminders.escalation-scan";
// Daily, mid-day UTC (see quiet-hours note above).
const ESCALATION_CRON = "0 18 * * *";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Don't escalate until the first touch is at least this old. */
export const ESCALATION_DELAY_DAYS = 3;
/** Stop escalating (and stop nagging) past this age. */
export const ESCALATION_MAX_DAYS = 21;
/** Channel ladder the escalation walks, in order. */
export const ESCALATION_LADDER = ["sms", "email"] as const;

const IN_PROGRESS_STATUSES = ["outreach_pending", "awaiting_response"];

// ── Pure planner ────────────────────────────────────────────────────

export interface EscalationEpisodeRow {
  id: string;
  patientId: string;
}
export interface EscalationConvRow {
  episodeId: string;
  channel: string;
  createdAtMs: number;
}
export interface EscalationPlanInput {
  /** Episodes still unresolved (status-filtered upstream). */
  episodes: EscalationEpisodeRow[];
  /** sms/email reminder conversations for those episodes. */
  conversations: EscalationConvRow[];
  nowMs: number;
  delayMs: number;
  maxMs: number;
  ladder: readonly string[];
}
export type EscalationTier =
  | { kind: "send"; channel: string }
  | { kind: "csr_exhausted" };
export interface EscalationAction {
  episodeId: string;
  patientId: string;
  tier: EscalationTier;
}

/**
 * Decide, per unresolved episode, whether to escalate to the next
 * channel or (once the ladder is exhausted) hand off to a CSR. Pure:
 * the job supplies the rows it read from Postgres.
 */
export function planReminderEscalations(
  input: EscalationPlanInput,
): EscalationAction[] {
  const byEpisode = new Map<
    string,
    { channels: Set<string>; earliestMs: number }
  >();
  for (const c of input.conversations) {
    if (!input.ladder.includes(c.channel)) continue;
    const e = byEpisode.get(c.episodeId) ?? {
      channels: new Set<string>(),
      earliestMs: Number.POSITIVE_INFINITY,
    };
    e.channels.add(c.channel);
    e.earliestMs = Math.min(e.earliestMs, c.createdAtMs);
    byEpisode.set(c.episodeId, e);
  }

  const actions: EscalationAction[] = [];
  for (const ep of input.episodes) {
    const info = byEpisode.get(ep.id);
    // No prior reminder → first touch is reminders.scan's job, not ours.
    if (!info) continue;
    const age = input.nowMs - info.earliestMs;
    if (age < input.delayMs) continue; // too soon
    if (age > input.maxMs) continue; // too old — stop nagging
    const next = input.ladder.find((ch) => !info.channels.has(ch));
    actions.push({
      episodeId: ep.id,
      patientId: ep.patientId,
      tier: next ? { kind: "send", channel: next } : { kind: "csr_exhausted" },
    });
  }
  return actions;
}

// ── IO runner ───────────────────────────────────────────────────────

export interface EscalationRunResult {
  skipped: boolean;
  enqueuedSms: number;
  enqueuedEmail: number;
  csrAlerts: number;
}

export async function runReminderEscalationScan(
  boss: Pick<PgBoss, "send">,
  now: Date = new Date(),
): Promise<EscalationRunResult> {
  const result: EscalationRunResult = {
    skipped: false,
    enqueuedSms: 0,
    enqueuedEmail: 0,
    csrAlerts: 0,
  };
  if (!(await isFeatureEnabled("reminder_escalation.dispatcher"))) {
    result.skipped = true;
    return result;
  }

  const supabase = getSupabaseServiceRoleClient();
  const horizonIso = new Date(
    now.getTime() - (ESCALATION_MAX_DAYS + 2) * DAY_MS,
  ).toISOString();

  // Unresolved episodes within the escalation horizon. PAGINATED:
  // PostgREST caps a single response at ~1000 rows, so the previous
  // unpaginated read silently truncated once the unresolved backlog
  // exceeded the cap — and any episode whose page was dropped looked
  // "never reminded" to the conversation-stitch below and stopped
  // escalating. Mirror the keyset-paging pattern in reminders.ts.
  const PAGE_SIZE = 1000;
  const episodes: EscalationEpisodeRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("episodes")
      .select("id, patient_id")
      .in("status", IN_PROGRESS_STATUSES)
      .gte("created_at", horizonIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) episodes.push({ id: r.id, patientId: r.patient_id });
    if (data.length < PAGE_SIZE) break;
  }
  if (episodes.length === 0) return result;

  // Reminder conversations for THOSE episodes. Fetch by the bounded
  // episode-id set (chunk the IN list ~200 ids, page within each chunk)
  // rather than scanning every sms/email conversation in the horizon: the
  // old unpaginated read also truncated at the ~1000-row cap, so episodes
  // whose reminder conversation was dropped looked un-reminded and would
  // re-escalate (or stall), and it scanned far more rows than needed.
  const episodeIds = episodes.map((e) => e.id);
  const conversations: EscalationConvRow[] = [];
  for (let i = 0; i < episodeIds.length; i += 200) {
    const idChunk = episodeIds.slice(i, i + 200);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("conversations")
        .select("id, episode_id, channel, created_at")
        .in("episode_id", idChunk)
        .in("channel", ["sms", "email"])
        .gte("created_at", horizonIso)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const c of data) {
        if (c.episode_id && c.created_at) {
          conversations.push({
            episodeId: c.episode_id,
            channel: c.channel,
            createdAtMs: new Date(c.created_at).getTime(),
          });
        }
      }
      if (data.length < PAGE_SIZE) break;
    }
  }

  const actions = planReminderEscalations({
    episodes,
    conversations,
    nowMs: now.getTime(),
    delayMs: ESCALATION_DELAY_DAYS * DAY_MS,
    maxMs: ESCALATION_MAX_DAYS * DAY_MS,
    ladder: ESCALATION_LADDER,
  });

  for (const action of actions) {
    if (action.tier.kind === "send") {
      const queue =
        action.tier.channel === "sms" ? SEND_SMS_JOB : SEND_EMAIL_JOB;
      await boss.send(queue, {
        patientId: action.patientId,
        episodeId: action.episodeId,
      });
      if (action.tier.channel === "sms") result.enqueuedSms += 1;
      else result.enqueuedEmail += 1;
    } else {
      await raiseUnresponsiveAlert(
        supabase,
        action.patientId,
        action.episodeId,
      );
      result.csrAlerts += 1;
    }
  }

  logger.info(
    {
      event: "reminders.escalation.completed",
      episodes: episodes.length,
      enqueued_sms: result.enqueuedSms,
      enqueued_email: result.enqueuedEmail,
      csr_alerts: result.csrAlerts,
    },
    "reminders.escalation-scan: completed",
  );
  return result;
}

async function raiseUnresponsiveAlert(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  patientId: string,
  episodeId: string,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select("id")
      .eq("patient_id", patientId)
      .eq("alert_type", "no_response")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    const { error: alertInsertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "no_response",
        severity: "warning",
        summary:
          "Unresponsive after SMS + email refill reminders — recommend a call.",
        metric_snapshot: { episodeId, escalation: "channels_exhausted" },
      });
    if (alertInsertErr) throw alertInsertErr;
  } catch (err) {
    logger.warn(
      {
        event: "reminders.escalation.alert_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "reminders.escalation-scan: failed to raise no_response alert",
    );
  }
}

export async function registerReminderEscalationJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, ESCALATION_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(ESCALATION_JOB, async () => {
    try {
      await runReminderEscalationScan(boss);
    } catch (err) {
      logger.error({ err }, "reminders.escalation-scan: job failed");
      throw err;
    }
  });
  await boss.schedule(ESCALATION_JOB, ESCALATION_CRON);
  logger.info({ cron: ESCALATION_CRON }, "reminders.escalation-scan scheduled");
}
