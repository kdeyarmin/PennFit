// In-process resupply worker.
//
// History
// -------
// This used to live in artifacts/resupply-worker as a separate
// artifact / process. The split bought crash isolation but cost a
// whole artifact (its own artifact.toml, build pipeline, healthz
// server, deploy gate, workflow) for a workload that is overwhelmingly
// quiet — an hourly reminder scan and a weekly attachment sweep, both
// driven by pg-boss against the same Postgres instance the API
// already talks to.
//
// The original design also explicitly anticipated colocation: the
// API's /readyz check probes the same `pgboss_resupply.version` table
// the worker's pg-boss instance creates, and gates traffic on it. The
// only thing the separation actually bought was an extra process to
// monitor.
//
// Now: pg-boss boots inside the API process. The /readyz check still
// works the same way (the schema is created by boss.start() — no
// matter which process calls it), and one shutdown handler covers
// both. If the resupply program ever needs throughput-class workloads
// that genuinely deserve their own process (high-frequency call queue
// processing, embedding generation, anything CPU-bound), splitting
// back out is a contained change — re-extract this directory back
// into an artifact and add the orchestration plumbing.

import PgBoss from "pg-boss";
import { logger } from "../lib/logger";
import { registerReminderJobs } from "./jobs/reminders.js";
import { registerPrescriptionAttachmentSweepJob } from "./jobs/prescription-attachment-sweep.js";
import { registerSmartTriggerEvaluatorJob } from "./jobs/smart-trigger-evaluator.js";
import { registerSmartTriggerSendJob } from "./jobs/smart-trigger-send.js";
import { registerRxRenewalSendJob } from "./jobs/rx-renewal-send.js";
import { registerIdempotencyKeysPruneJob } from "./jobs/idempotency-keys-prune.js";
import { registerOnboardingCheckinJobs } from "./jobs/onboarding-checkins.js";
import { registerBulkCampaignTickJob } from "./jobs/bulk-campaign-tick.js";
import { registerPatientDocumentsRetentionSweepJob } from "./jobs/patient-documents-retention-sweep.js";
import { registerRecallNotificationSendJob } from "./jobs/recall-notifications-send.js";
import { registerMaintenanceNudgeJob } from "./jobs/maintenance-nudges.js";
import { registerFitterLeadReengageJob } from "./jobs/fitter-lead-reengage.js";
import { registerAuditLogArchiveSweepJob } from "./jobs/audit-log-archive-sweep.js";
import { registerTherapyNightlySyncJob } from "./jobs/therapy-integrations-nightly-sync.js";
import { registerCoachingProgressJob } from "./jobs/coaching-plan-progress.js";
import { registerPriorAuthExpirySweepJob } from "./jobs/prior-auth-expiry-sweep.js";
import { registerShopOrderDeliveryFollowupJob } from "./jobs/shop-order-delivery-followup.js";
import { registerTherapyMilestonesJob } from "./jobs/therapy-milestones.js";
import { registerLapsedCustomerWinbackJob } from "./jobs/lapsed-customer-winback.js";
import { registerDeductibleResetPushJob } from "./jobs/deductible-reset-push.js";

let bossInstance: PgBoss | null = null;
let workerReady = false;

export function isWorkerReady(): boolean {
  return workerReady;
}

export function getBoss(): PgBoss | null {
  return bossInstance;
}

/**
 * Start and configure the resupply in-process pg-boss worker and register scheduled jobs.
 *
 * Throws if `DATABASE_URL` is not set. On success this sets the module's pg-boss instance,
 * attaches error and monitor-state handlers that emit structured logs, registers resupply-related
 * recurring and dispatch jobs (reminders, retention/cleanup tasks, campaign ticks, nightly syncs,
 * prior-auth expiry sweep, etc.), and marks the worker ready.
 */
export async function startWorker(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    // env-check.ts already validates this at boot, but we keep a
    // local guard so this module is independently safe to call.
    throw new Error("DATABASE_URL must be set for the resupply worker.");
  }

  // Periodic state-monitor heartbeat. With `monitorStateIntervalSeconds`
  // set, pg-boss emits a `monitor-states` event with per-queue counts
  // (created/active/retry/failed/etc) on the given cadence. We use it
  // as a poor-person's DLQ-alert: when ANY queue carries a non-zero
  // `failed` or `retry` count, we emit ONE structured WARN line per
  // tick listing the affected queues — that line is the canonical
  // grep target for "are crons quietly broken?". When everything is
  // clean we stay silent so the log isn't dominated by heartbeats.
  // 60 seconds is tight enough to surface a stuck queue quickly and
  // loose enough to add no meaningful DB load.
  const MONITOR_STATE_INTERVAL_SECONDS = 60;

  const boss = new PgBoss({
    connectionString: databaseUrl,
    // Dedicated schema so pg-boss tables never collide with our
    // application tables. The /readyz check also probes this exact
    // schema for its `version` table — keep them in lockstep.
    schema: "pgboss_resupply",
    monitorStateIntervalSeconds: MONITOR_STATE_INTERVAL_SECONDS,
  });

  boss.on("error", (err) => {
    logger.error({ err, event: "pg_boss_error" }, "pg-boss error");
  });

  boss.on("monitor-states", (states) => {
    // pg-boss MonitorStates shape:
    //   { all, created, retry, active, completed, cancelled, failed,
    //     queues: { [name]: { ...same } } }
    // We only care about the per-queue rollup. A non-zero `failed`
    // means at least one job exhausted its retry policy; a non-zero
    // `retry` means at least one job is currently between attempts.
    // Both are worth surfacing.
    const trouble: Array<{
      queue: string;
      failed: number;
      retry: number;
    }> = [];
    for (const [queue, counts] of Object.entries(states.queues ?? {})) {
      if (counts.failed > 0 || counts.retry > 0) {
        trouble.push({
          queue,
          failed: counts.failed,
          retry: counts.retry,
        });
      }
    }
    if (trouble.length === 0) return;
    logger.warn(
      {
        event: "pg_boss_jobs_unhealthy",
        queues: trouble,
        intervalSeconds: MONITOR_STATE_INTERVAL_SECONDS,
      },
      "pg-boss queues report failed or retrying jobs",
    );
  });

  // Failed-job alerting (P1.2). pg-boss does NOT emit a per-job
  // "failed" event we can subscribe to directly; instead, the
  // `monitor-states` snapshot exposes the rolling count of jobs in
  // each terminal state (`failed`, `cancelled`, etc.) per queue. We
  // remember the last-seen `failed` count per queue and fire ONE
  // structured warn line on each delta — i.e. a single permanent
  // failure logs once, not every monitoring tick. ops dashboards can
  // alert on `event: "pgboss_jobs_failed"` to page on a stuck queue.
  //
  // The snapshot lives in this closure and resets on worker restart;
  // a restart re-baselines counts so historical archived failures
  // don't trigger a false alert at boot. Tradeoff: a process bounce
  // immediately after a failure could miss a single alert, which is
  // acceptable — the failed-state row is still visible in the DB and
  // the next failure will alert.
  const lastFailedCounts = new Map<string, number>();
  boss.on("monitor-states", (snapshot) => {
    for (const [queueName, state] of Object.entries(snapshot.queues ?? {})) {
      const prev = lastFailedCounts.get(queueName) ?? state.failed;
      if (state.failed > prev) {
        logger.warn(
          {
            event: "pgboss_jobs_failed",
            queue: queueName,
            newly_failed: state.failed - prev,
            total_failed: state.failed,
            queue_size: state.all,
            retry_pending: state.retry,
            active: state.active,
          },
          `pg-boss queue '${queueName}' has ${state.failed - prev} newly failed job(s) (${state.failed} total)`,
        );
      }
      lastFailedCounts.set(queueName, state.failed);
    }
  });

  await boss.start();
  bossInstance = boss;

  // Register reminder + attachment-sweep jobs. The handlers
  // themselves tolerate a partially-configured messaging surface
  // (they log+exit-0 instead of failing the job) so a half-configured
  // deploy doesn't fill the pg-boss retry queue with permanent
  // failures. See jobs/reminders.ts for the full rationale.
  await registerReminderJobs(boss);
  await registerPrescriptionAttachmentSweepJob(boss);
  // Phase G.13 — daily smart-trigger evaluator scan. Idempotent
  // re-run; the partial-unique index on
  // patient_smart_trigger_events guarantees no double-fires.
  await registerSmartTriggerEvaluatorJob(boss);
  // Phase G.14 — daily smart-trigger send-due dispatch (50 min
  // after the evaluator). Email then SMS; both channels share
  // sent_at so a patient is never nudged twice.
  await registerSmartTriggerSendJob(boss);
  // Phase G.15 — daily Rx-renewal dispatch (30 min after smart-
  // trigger send so we don't double-burst the email vendor).
  // Email then SMS; both channels share renewal_requested_at.
  await registerRxRenewalSendJob(boss);
  // D-12 — daily prune of expired idempotency_keys rows.
  // Rows past their 24h TTL are functionally inert (treated as misses
  // by the middleware) but accumulate indefinitely without a prune.
  await registerIdempotencyKeysPruneJob(boss);
  // HIPAA retention sweep — nightly. Backfills retention_until_at
  // on legacy rows and flags expired rows for compliance review.
  // Destruction itself is human-triggered via the admin UI.
  await registerPatientDocumentsRetentionSweepJob(boss);
  // Recall notification send-side worker — drains queued
  // recall_notifications rows once per day. The matcher
  // (POST /admin/equipment-recalls/:id/match-assets) populates
  // the queue; this job actually delivers email + SMS.
  await registerRecallNotificationSendJob(boss);
  // Patient hygiene weekly nudge — emails patients with overdue
  // mask-wipe / hose-wash / etc. tasks. Sunday 11:13 UTC.
  await registerMaintenanceNudgeJob(boss);
  // Abandoned-fitter re-engagement — daily 09:37 UTC. Scans
  // resupply.fitter_leads for opted-in rows aged 3–30 days that
  // never produced a public.orders row, emails a "finish your
  // fitting" nudge, and stamps nudged_at so it never re-sends.
  await registerFitterLeadReengageJob(boss);
  // HIPAA audit-log retention sweep — nightly flag of rows past
  // the 6-year floor. Destruction stays human-triggered.
  await registerAuditLogArchiveSweepJob(boss);
  // Adherence coaching progress sweep — refresh latest_compliance_pct
  // on open plans and auto-flip outreach_made → improving when the
  // patient's recent 30-night adherence crosses target.
  await registerCoachingProgressJob(boss);
  // Phase B.1.1 — daily multi-channel onboarding check-in dispatch
  // (day 3 / 7 / 30 / 60 / 90) + daily compliance scan that creates
  // CSR alerts for at-risk patients. Both crons share the Supabase
  // service-role client and are idempotent on re-run.
  await registerOnboardingCheckinJobs(boss);

  // Bulk-campaign send worker (Phase B). On-demand: tick jobs are
  // enqueued by the /admin/bulk-campaigns/:id/start endpoint and
  // self-re-enqueue every TICK_INTERVAL_SECONDS until the campaign
  // is drained, paused, or cancelled.
  await registerBulkCampaignTickJob(boss);

  // Nightly bulk refresh of every active therapy-cloud link. Runs at
  // 04:30 UTC; persists snapshot recentNights into the canonical
  // patient_therapy_nights table for downstream consumers.
  await registerTherapyNightlySyncJob(boss);

  // Daily prior-authorization expiry sweep — flips approved → expired
  // on the day after approved_through, and emits CSR heads-up alerts
  // at T-30 / T-14 / T-7 days so billing can chase a renewal before
  // claims start denying. The /patients/:id/prior-authorizations
  // route header has long claimed this sweep existed; this is its
  // implementation. Runs at 03:47 UTC daily.
  await registerPriorAuthExpirySweepJob(boss);

  // Daily post-delivery follow-up dispatcher. Scans paid shop orders
  // that delivered 3-14 days ago without a follow-up stamp and sends
  // a "how did it go?" email + push. Highest-ROI satisfaction surface
  // a DME supplier has; also creates a clean intake for early returns
  // before the patient gives up. Runs at 14:23 UTC daily.
  await registerShopOrderDeliveryFollowupJob(boss);

  // Daily therapy-milestone evaluator + sender. Scans
  // patient_therapy_nights for engagement signals (100th night, first
  // anniversary, first 30-night adherence window) and sends a
  // celebration email per detected milestone. Idempotent via the
  // patient_therapy_milestones UNIQUE constraint. Runs at 04:53 UTC,
  // paired with the therapy nightly sync (04:30) so we work against
  // fresh data.
  await registerTherapyMilestonesJob(boss);

  // Weekly lapsed-customer win-back. Mondays at 13:17 UTC. Sends one
  // "we miss you" email to any shop_customers row whose last paid
  // order is 180–730 days old (lapsed but not stale-registration)
  // and who hasn't been win-back'd within the past 12 months. Honors
  // communication_preferences.emailMarketing.
  await registerLapsedCustomerWinbackJob(boss);

  // Daily deductible-reset push — short-circuits unless current month
  // is November. Sends a "use your benefits before Jan 1" email to
  // every active customer (paid order within the past 730 days) who
  // hasn't been stamped for the current year. Daily-and-short-circuit
  // makes the cron self-healing across deploys that miss Nov 1.
  await registerDeductibleResetPushJob(boss);

  workerReady = true;
  logger.info(
    "resupply in-process worker ready (pg-boss started, reminders + attachment-sweep + smart-trigger-evaluator + smart-trigger-send + rx-renewal-send + idempotency-keys-prune + onboarding-checkins scheduled)",
  );
}

export async function stopWorker(): Promise<void> {
  workerReady = false;
  if (!bossInstance) return;
  try {
    await bossInstance.stop({ graceful: true, timeout: 10_000 });
  } catch (err) {
    logger.error({ err }, "error stopping pg-boss");
  }
  bossInstance = null;
}
