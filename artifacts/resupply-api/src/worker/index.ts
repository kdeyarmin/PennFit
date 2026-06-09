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
import { registerReminderEscalationJob } from "./jobs/reminder-escalation.js";
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
import { registerFitterLeadFirstDayNudgeJob } from "./jobs/fitter-lead-first-day-nudge.js";
import { registerFitterSupplyCampaignJob } from "./jobs/fitter-supply-campaign.js";
import { registerFitterConversionAttributionJob } from "./jobs/fitter-conversion-attribution.js";
import { registerCartAbandonmentJob } from "./jobs/cart-abandonment-scan.js";
import { registerFailedEmailDigestJob } from "./jobs/failed-order-emails-digest.js";
import { registerTherapyNightlySyncJob } from "./jobs/therapy-integrations-nightly-sync.js";
import { registerEligibilityReverifyBatchJob } from "./jobs/eligibility-reverify-batch.js";
import { registerAutoSubmitBatchJob } from "./jobs/auto-submit-batch.js";
import { registerBillHoldSweepJob } from "./jobs/bill-hold-sweep.js";
import { registerClinicalOutreachBatchJob } from "./jobs/clinical-outreach-batch.js";
import { registerSlaEscalationSweepJob } from "./jobs/sla-escalation-sweep.js";
import { registerTherapyFleetSnapshotJob } from "./jobs/therapy-fleet-daily-snapshot.js";
import { registerMetricsSnapshotJob } from "./jobs/metrics-snapshot.js";
import { registerMetricAlertsEvaluatorJob } from "./jobs/metric-alerts-evaluator.js";
import { registerMetricAlertsNotifyJob } from "./jobs/metric-alerts-notify.js";
import { registerOwnerDigestJob } from "./jobs/owner-digest.js";
import { registerTherapyFleetAlertsJob } from "./jobs/therapy-fleet-alerts-scan.js";
import { registerSetupDeadlineOutreachJob } from "./jobs/therapy-setup-deadline-outreach.js";
import { registerCoachingProgressJob } from "./jobs/coaching-plan-progress.js";
import { registerCoachingAutoEnrollJob } from "./jobs/coaching-auto-enroll.js";
import { registerPayerEstimateStatsJob } from "./jobs/payer-estimate-stats-refresh.js";
import { registerPriorAuthExpirySweepJob } from "./jobs/prior-auth-expiry-sweep.js";
import { registerShopOrderDeliveryFollowupJob } from "./jobs/shop-order-delivery-followup.js";
import { registerPatientPacketReminderJob } from "./jobs/patient-packet-reminders.js";
import { registerTherapyMilestonesJob } from "./jobs/therapy-milestones.js";
import { registerLapsedCustomerWinbackJob } from "./jobs/lapsed-customer-winback.js";
import { registerDeductibleResetPushJob } from "./jobs/deductible-reset-push.js";
import { registerQuarterlyTherapySummaryJob } from "./jobs/quarterly-therapy-summary.js";
import { registerLifecycleTouchpointsJob } from "./jobs/lifecycle-touchpoints.js";
import { registerOfficeAllyInboundPollJob } from "./jobs/office-ally-inbound-poll.js";
import { registerPaMcoSlaSweepJob } from "./jobs/pa-mco-sla-sweep.js";
import { registerPecosSyncJob } from "./jobs/pecos-sync.js";
import { registerCappedRentalAdvanceJob } from "./jobs/capped-rental-advance.js";
import { registerPaymentPlanAutochargeJob } from "./jobs/payment-plan-autocharge.js";
import { registerPatientAutopayChargeJob } from "./jobs/patient-autopay-charge.js";
import { registerDwoExpirySweepJob } from "./jobs/dwo-expiry-sweep.js";
import { registerWebhookDispatcherJob } from "./jobs/webhook-dispatcher.js";
import { registerAutoWorkflowJob } from "./jobs/auto-workflow.js";
import { registerInvitePasswordExpiryNotifyJob } from "./jobs/invite-password-expiry-notify.js";
import { registerLowStockAlertsJob } from "./jobs/low-stock-alerts.js";
import { registerPrescriptionRequestAutoDraftJob } from "./jobs/prescription-request-auto-draft.js";
import { registerConversationOrphanAssigneeSweepJob } from "./jobs/conversation-orphan-assignee-sweep.js";
import { registerIfProvisioned } from "./lib/table-guard.js";
import { resolvePgBossPoolMax } from "./lib/pgboss-pool.js";

let bossInstance: PgBoss | null = null;
let workerReady = false;
// Single-flight guard for startWorker(): the in-flight start promise,
// or null when no start is running. Lets boot retries join an
// in-progress attempt instead of opening a second pg-boss instance.
let workerStartInFlight: Promise<void> | null = null;

export function isWorkerReady(): boolean {
  return workerReady;
}

export function getBoss(): PgBoss | null {
  return bossInstance;
}

/**
 * Start and configure the resupply in-process pg-boss worker and register all resupply scheduled and dispatch jobs.
 *
 * Idempotent and single-flight: a no-op when pg-boss is already running and fully registered, and when a start is
 * already in progress (e.g. a boot retry that raced a slow first attempt) callers join the in-flight attempt rather
 * than opening a second pg-boss connection / advisory-lock holder.
 *
 * On success this sets the module-level pg-boss instance, attaches structured error and monitor-state handlers,
 * registers recurring resupply and dispatch jobs (reminders, sweeps, campaign ticks, nightly syncs, webhook/inbound
 * dispatchers, workflows, alerts, and other scheduled tasks), and marks the worker ready.
 *
 * @throws If `DATABASE_URL` is not set in the environment.
 */
export async function startWorker(): Promise<void> {
  if (bossInstance && workerReady) {
    // Fully started and all job registrations complete — no-op.
    return;
  }
  if (workerStartInFlight) {
    // A start is already in progress; join it instead of racing a
    // second boss.start() (which would contend on the advisory lock).
    return workerStartInFlight;
  }
  const inFlight = doStartWorker().finally(() => {
    if (workerStartInFlight === inFlight) {
      workerStartInFlight = null;
    }
  });
  workerStartInFlight = inFlight;
  return workerStartInFlight;
}

async function doStartWorker(): Promise<void> {
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

  // Mask the DATABASE_URL for logging: strip the password component
  // so we can confirm which host/db pg-boss is targeting without
  // leaking credentials into the log stream.
  const maskedDatabaseUrl = databaseUrl.replace(
    /\/\/([^:]+):([^@]+)@/,
    "//$1:***@",
  );

  // Bound pg-boss's dedicated connection pool so the worker can't
  // exhaust Postgres connection slots and starve PostgREST — the path
  // admin sign-in reads through. Left unbounded, the worker pool
  // (multiplied across a deploy-rollover overlap or extra replicas) can
  // consume every slot, at which point every query 503s and sign-in
  // reports "We can't reach the credentials store." See
  // ./lib/pgboss-pool.ts; tunable via PGBOSS_POOL_MAX.
  const pgBossConfig = {
    schema: "pgboss_resupply",
    monitorStateIntervalSeconds: MONITOR_STATE_INTERVAL_SECONDS,
    max: resolvePgBossPoolMax(process.env.PGBOSS_POOL_MAX),
  };

  let boss: PgBoss;

  if (bossInstance) {
    // boss.start() succeeded in a prior attempt but one or more job
    // registrations failed; reuse the already-running instance so we
    // don't contend on the advisory lock a second time.
    boss = bossInstance;
    logger.info(
      { event: "pg_boss_registration_retry" },
      "pg-boss: boss already started — re-running job registrations to complete setup",
    );
  } else {
    logger.info(
      {
        event: "pg_boss_starting",
        database_url: maskedDatabaseUrl,
        pg_boss_config: pgBossConfig,
      },
      "pg-boss: starting boss.start()",
    );

    boss = new PgBoss({
      connectionString: databaseUrl,
      // Dedicated schema so pg-boss tables never collide with our
      // application tables. The /readyz check also probes this exact
      // schema for its `version` table — keep them in lockstep.
      ...pgBossConfig,
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
    // The snapshot lives in this closure but the first monitor-states
    // tick after boot fires a one-time `pgboss_jobs_failed_initial`
    // line whenever there's a non-zero `failed` count. Without it, a
    // process bounce immediately after a fresh failure would silently
    // re-baseline at the post-failure count and never alert — a
    // crashloop could mask every alert from this surface entirely.
    // Subsequent ticks delta off `prev` as before so a single permanent
    // failure only emits one steady-state warning.
    const lastFailedCounts = new Map<string, number>();
    boss.on("monitor-states", (snapshot) => {
      for (const [queueName, state] of Object.entries(snapshot.queues ?? {})) {
        const baselined = lastFailedCounts.has(queueName);
        const prev = lastFailedCounts.get(queueName) ?? 0;
        if (!baselined && state.failed > 0) {
          // First tick after boot AND there's a non-zero failed count
          // already on the queue — surface it once so a restart
          // doesn't swallow alerts for failures that landed during
          // the restart window.
          logger.warn(
            {
              event: "pgboss_jobs_failed_initial",
              queue: queueName,
              total_failed: state.failed,
              queue_size: state.all,
              retry_pending: state.retry,
              active: state.active,
            },
            `pg-boss queue '${queueName}' booted with ${state.failed} failed job(s) on the books`,
          );
        } else if (state.failed > prev) {
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

    try {
      await boss.start();
    } catch (err) {
      // Capture the full error with stack trace and any nested cause
      // so we can distinguish DB connectivity failures, schema
      // permission errors, and pg-boss internal errors at a glance.
      const serialized: Record<string, unknown> = {
        event: "pg_boss_start_failed",
        database_url: maskedDatabaseUrl,
        pg_boss_config: pgBossConfig,
      };
      if (err instanceof Error) {
        serialized["name"] = err.name;
        serialized["message"] = err.message;
        serialized["stack"] = err.stack;
        // Node.js Error.cause — present on pg-boss connection errors
        // and any error thrown with `new Error(msg, { cause })`.
        if ("cause" in err && err.cause != null) {
          const cause = err.cause;
          serialized["cause"] =
            cause instanceof Error
              ? { name: cause.name, message: cause.message, stack: cause.stack }
              : String(cause);
        }
      } else {
        serialized["raw"] = String(err);
      }
      logger.fatal(
        serialized,
        "pg-boss: boss.start() threw — cannot start worker",
      );
      // Release the connection pool this failed instance opened before
      // re-throwing. pg-boss opens its pool early in start() (before the
      // step that fails when the database is out of connection slots),
      // and a failed start() poisons the instance — its private
      // `#starting` flag never resets, so a retry on the same object is a
      // silent no-op and the boot-retry path in startWorker() must build
      // a FRESH PgBoss next time. Without this stop(), every failed
      // attempt therefore orphans a still-open pool; during an outage the
      // in-app retry loop plus Railway's ON_FAILURE restarts pile up
      // orphaned pools until they exhaust max_connections and starve
      // PostgREST (the path admin sign-in reads through). `bossInstance`
      // is only assigned on success below, so this `boss` is otherwise
      // unreachable for cleanup. graceful:false closes the pool right
      // away — a failed start has no in-flight job handlers to drain.
      try {
        await boss.stop({ graceful: false });
      } catch (stopErr) {
        logger.warn(
          {
            event: "pg_boss_failed_start_cleanup_error",
            err: stopErr instanceof Error ? stopErr.message : String(stopErr),
          },
          "pg-boss: releasing the failed-start connection pool errored — connections may linger until idle timeout",
        );
      }
      throw err;
    }

    logger.info(
      { event: "pg_boss_started", database_url: maskedDatabaseUrl },
      "pg-boss: boss.start() succeeded",
    );

    bossInstance = boss;
  }

  // Register reminder + attachment-sweep jobs. The handlers
  // themselves tolerate a partially-configured messaging surface
  // (they log+exit-0 instead of failing the job) so a half-configured
  // deploy doesn't fill the pg-boss retry queue with permanent
  // failures. See jobs/reminders.ts for the full rationale.
  await registerReminderJobs(boss);
  // Daily multi-channel escalation for unanswered reminders (#7).
  // Additive companion to the hourly scan; feature-flagged
  // (reminder_escalation.dispatcher) and reuses the SEND_* queues.
  await registerReminderEscalationJob(boss);
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
  await registerIfProvisioned(
    boss,
    "recall-notifications.send",
    ["equipment_recalls", "recall_notifications"],
    registerRecallNotificationSendJob,
  );
  // Patient hygiene weekly nudge — emails patients with overdue
  // mask-wipe / hose-wash / etc. tasks. Sunday 11:13 UTC.
  await registerIfProvisioned(
    boss,
    "patient-maintenance.weekly-nudge",
    ["patient_maintenance_log", "patient_maintenance_nudges"],
    registerMaintenanceNudgeJob,
  );
  // Abandoned-fitter re-engagement — daily 09:37 UTC. Scans
  // resupply.fitter_leads for opted-in rows aged 3–30 days that
  // never produced a public.orders row, emails a "finish your
  // fitting" nudge, and stamps nudged_at so it never re-sends.
  await registerFitterLeadReengageJob(boss);
  // First-day fitter-lead nudge — hourly at :19. Catches the
  // in-funnel patient who started 18-30 hours ago and never
  // finished. Sends email + SMS (when opted in via the phone field
  // added in 0121) with same-day-warm copy. Uses a separate
  // first_day_nudged_at column so the 3-30d worker above can still
  // fire later if the patient stays cold.
  await registerFitterLeadFirstDayNudgeJob(boss);
  // Hourly at :29 — attribute newly-placed orders back to the
  // fitter_leads row whose email matches the order. Stamps
  // first_order_id + flips journey_stage='converted' so the supply-
  // campaign dispatcher stops sending to a patient who already
  // bought. Sequenced before the campaign tick (:43).
  await registerFitterConversionAttributionJob(boss);
  // Hourly at :43 — multi-touch supply-campaign nurture for leads
  // who completed the fitter (reached /results) but haven't ordered
  // yet. Six touchpoints over 60 days with copy that escalates
  // from soft recap → social proof → FSA reminder → one-time
  // discount → educational → final. Gated by both
  // RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED (boot) and
  // fitter_supply_campaign.dispatcher (runtime flag).
  await registerFitterSupplyCampaignJob(boss);
  // Cart-abandonment sweep — hourly at :13. Runs the same dispatcher
  // that backs POST /admin/shop/abandoned-carts/send-due so abandoned
  // carts get nudged without a human clicking the button. Suppression
  // (comm-prefs, DND, 24h cool-down, single-nudge-per-cart) is owned
  // by the shared helper. Off by default — flip
  // RESUPPLY_CART_ABANDONMENT_CRON_ENABLED=1 to turn it on.
  await registerCartAbandonmentJob(boss);
  // Failed-email order digest — daily at 13:00 UTC. Scans
  // public.orders for rows with email_status=failed in the last 24h
  // and sends a single PHI-safe summary email to
  // RESUPPLY_ADMIN_ALERTS_EMAIL so ops can chase the failures
  // without hand-querying the DB. Body contains only order_reference
  // + created_at; patient name, email, error text NEVER appear.
  // Off by default — requires the flag AND the recipient env var.
  await registerFailedEmailDigestJob(boss);
  // Adherence coaching progress sweep — refresh latest_compliance_pct
  // on open plans and auto-flip outreach_made → improving when the
  // patient's recent 30-night adherence crosses target.
  await registerIfProvisioned(
    boss,
    "coaching-plan.progress-sweep",
    ["patient_coaching_plans"],
    registerCoachingProgressJob,
  );
  // Adherence coaching auto-enroll sweep (RT #R3) — daily at 05:23,
  // after nightly-sync + progress-sweep. Scores active early-window
  // patients and opens a coaching plan for the at-risk ones with no
  // recent/open plan. OFF by default — flip
  // RESUPPLY_COACHING_AUTO_ENROLL_ENABLED=1 to turn it on.
  await registerCoachingAutoEnrollJob(boss);
  // Learned insurance-estimate stats (O2) — weekly recompute of P50/P90
  // patient OOP per payer slug from adjudicated claims, into the small
  // table the public estimate route reads. Inert until 0230 lands.
  await registerIfProvisioned(
    boss,
    "insurance-estimate.stats-refresh",
    ["payer_estimate_stats"],
    registerPayerEstimateStatsJob,
  );
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

  // Eligibility re-verification batch (Biller #31). Queue + worker
  // always register; the recurring cron only attaches when
  // ELIGIBILITY_REVERIFY_CRON is set (opt-in — it emits outbound 270s).
  await registerEligibilityReverifyBatchJob(boss);

  // Automatic claim submission (auto-submit engine). Queue + worker
  // always register (so the operator "approve & submit" route works);
  // the recurring cron attaches only when CLAIMS_AUTOSUBMIT_CRON is set,
  // and even then transmits nothing until the billing.auto_submit_claims
  // feature flag is flipped ON in the admin Control Center (opt-in — it
  // emits outbound 837P claim files).
  await registerAutoSubmitBatchJob(boss);

  // Bill-hold sweep (0253). Backfills the default signed-paperwork
  // requirement set onto draft claims that lack one (so the hold covers
  // ALL claims) and auto-bumps stale reminders. Queue + worker always
  // register; the recurring cron attaches only when BILL_HOLD_SWEEP_CRON
  // is set (opt-in — it seeds holds across the draft-claim backlog).
  await registerBillHoldSweepJob(boss);

  // Proactive clinical outreach (RT #23). Queue + worker always register;
  // the recurring cron only attaches when CLINICAL_OUTREACH_CRON is set
  // (opt-in — it emits outbound patient contact).
  await registerClinicalOutreachBatchJob(boss);

  // SLA auto-escalation (CSR C2). Flags conversations past their SLA
  // deadline as escalated so they surface in the inbox "escalated" view.
  // Internal visibility flag only (no patient contact). Queue + worker
  // always register; the recurring cron only attaches when
  // RESUPPLY_SLA_ESCALATION_CRON is set.
  await registerSlaEscalationSweepJob(boss);

  // Daily snapshot of the therapy-fleet metrics into
  // therapy_fleet_daily_metrics, 30 min after the nightly sync, so the
  // fleet trend / sparklines reflect freshly-synced nights.
  await registerTherapyFleetSnapshotJob(boss);

  // Daily headline-KPI snapshot (06:30 UTC) into metrics_daily — the F2
  // metrics substrate the threshold evaluator + owner digest read from.
  await registerMetricsSnapshotJob(boss);

  // Evaluate metric_thresholds against the fresh snapshot (06:45 UTC)
  // and write metric_alerts on a breach.
  await registerMetricAlertsEvaluatorJob(boss);

  // Email a SendGrid digest of new KPI alerts to admins (06:50 UTC).
  await registerMetricAlertsNotifyJob(boss);

  // Weekly owner KPI digest (Mondays 13:00 UTC).
  await registerOwnerDigestJob(boss);

  // Nightly therapy-fleet alerts scan (05:15 UTC): maintains the
  // internal alert feed and, when the (default-off) auto-outreach flag
  // is on, sends consented at-risk patients a gentle adherence SMS.
  await registerTherapyFleetAlertsJob(boss);

  // Daily CPAP setup-deadline outreach (05:05 UTC, BEFORE the 05:15
  // alerts-scan). Turns the 90-day setup-adherence countdown into
  // proactive, escalating SMS ("about N more 4h+ nights in D days to
  // keep coverage") for on_track/at_risk patients. Shares the alerts-scan
  // 14-day frequency-cap key so the two never double-text a patient.
  // Gated by the same therapy_fleet.auto_outreach + sms.reminders flags.
  await registerSetupDeadlineOutreachJob(boss);

  // Daily prior-authorization expiry sweep — flips approved → expired
  // on the day after approved_through, and emits CSR heads-up alerts
  // at T-30 / T-14 / T-7 days so billing can chase a renewal before
  // claims start denying. The /patients/:id/prior-authorizations
  // route header has long claimed this sweep existed; this is its
  // implementation. Runs at 03:47 UTC daily.
  await registerIfProvisioned(
    boss,
    "prior-auth.expiry-sweep",
    ["prior_authorizations"],
    registerPriorAuthExpirySweepJob,
  );

  // Daily post-delivery follow-up dispatcher. Scans paid shop orders
  // that delivered 3-14 days ago without a follow-up stamp and sends
  // a "how did it go?" email + push. Highest-ROI satisfaction surface
  // a DME supplier has; also creates a clean intake for early returns
  // before the patient gives up. Runs at 14:23 UTC daily.
  await registerShopOrderDeliveryFollowupJob(boss);

  // Daily sweep that re-sends signing links for unsigned patient
  // packets (email + SMS), capped per packet. Runtime-gated by the
  // patient_packets.autoremind feature flag (OFF by default). Runs at
  // 15:33 UTC daily.
  await registerPatientPacketReminderJob(boss);

  // Daily therapy-milestone evaluator + sender. Scans
  // patient_therapy_nights for engagement signals (100th night, first
  // anniversary, first 30-night adherence window) and sends a
  // celebration email per detected milestone. Idempotent via the
  // patient_therapy_milestones UNIQUE constraint. Runs at 04:53 UTC,
  // paired with the therapy nightly sync (04:30) so we work against
  // fresh data.
  await registerIfProvisioned(
    boss,
    "therapy-milestones.run",
    ["patient_therapy_milestones"],
    registerTherapyMilestonesJob,
  );

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

  // Daily quarterly therapy-summary email — every 90 days per
  // patient, pushes the same 90-day rollup that /shop/me/quarterly-
  // summary already builds into the patient's inbox. The endpoint
  // was pull-only; this worker makes it pull-AND-push so payers
  // and primary-care physicians get the summary at the cadence
  // they ask for. Runs at 06:17 UTC, gated by emailMarketing on
  // the patient's shop_customers comm-prefs.
  await registerQuarterlyTherapySummaryJob(boss);

  // Daily lifecycle touchpoints — birthday + sleep-therapy
  // anniversary celebration emails. Calendar signals complement the
  // therapy-count milestones in 0120 (100/365 nights, first
  // adherence month) and consistently show the highest open + click
  // rates in DME coaching literature. Runs at 13:33 UTC, idempotent
  // via year stamps on patients.
  await registerLifecycleTouchpointsJob(boss);

  // Every 15 minutes — poll Office Ally's outbound SFTP directory
  // for 999 / 277CA / 835 files we haven't already processed.
  // No-op when no clearinghouse_credentials row exists and no
  // OFFICE_ALLY_* env is configured (dev / preview).
  await registerOfficeAllyInboundPollJob(boss);

  // Every 6 hours — refresh PA Medicaid MCO 7-day SLA status
  // (mig 0133). Stamps mco_sla_target_date + status and queues
  // CSR alerts on at-risk + missed transitions.
  await registerPaMcoSlaSweepJob(boss);

  // Daily CMS PECOS Order/Referring sync. Powers the preflight
  // "ordering provider not PECOS-enrolled" denial blocker.
  await registerIfProvisioned(
    boss,
    "pecos.sync",
    ["providers", "providers_pecos_status"],
    registerPecosSyncJob,
  );

  // Daily capped-rental month advance (mig 0134). For each active
  // cycle past the next anniversary, generates a draft monthly
  // claim with the correct KH/KI/KX modifier rotation.
  await registerCappedRentalAdvanceJob(boss);

  // Auto-charge due patient payment-plan installments off-session
  // (mig 0255). Triple-gated: opt-in cron (BILLING_PAYMENT_PLAN_
  // AUTOCHARGE_CRON), the seeded-OFF billing.payment_plan_autocharge
  // flag, and per-plan patient authorization. Inert by default.
  await registerPaymentPlanAutochargeJob(boss);

  // Auto-charge a patient's outstanding balance off-session against the
  // card they saved + authorized in the portal (mig 0256). Triple-gated:
  // opt-in cron (BILLING_PATIENT_AUTOPAY_CRON), the seeded-OFF
  // billing.patient_autopay flag, and the per-patient autopay toggle.
  // Inert by default.
  await registerPatientAutopayChargeJob(boss);

  // Weekly DWO / CMN renewal sweep (mig 0134). T-60/T-30/T-7 CSR
  // alerts before expires_on.
  await registerIfProvisioned(
    boss,
    "dwo.expiry-sweep",
    ["dwo_documents"],
    registerDwoExpirySweepJob,
  );

  // Every minute — drain webhook_deliveries with exponential
  // backoff retries. HMAC-SHA256-signed POSTs to subscriber URLs.
  await registerIfProvisioned(
    boss,
    "webhook.dispatch",
    ["webhook_deliveries", "webhook_subscriptions"],
    registerWebhookDispatcherJob,
  );

  // Every 5 minutes — auto-workflow pass: heuristic-score + AI-scrub
  // risky drafts, AI-analyze fresh denials, publish
  // billing_statement.due for patients with cooldown-clear balances.
  await registerIfProvisioned(
    boss,
    "billing.auto-workflow",
    ["insurance_claims"],
    registerAutoWorkflowJob,
  );

  // Hourly — warn invited team members whose operator-typed
  // temporary password is approaching ADMIN_PASSWORD_TTL_MS (heads-up
  // at ~T-2 days) and again the moment it expires. Idempotency via
  // stamp columns on resupply_auth.password_credentials added in
  // migration 0143.
  await registerInvitePasswordExpiryNotifyJob(boss);

  // Every 6 hours — shop inventory low-stock alert digest. Reads
  // Stripe catalog, dedups per-SKU via resupply.low_stock_alert_state,
  // emails RESUPPLY_ADMIN_EMAILS one rollup per tick.
  await registerIfProvisioned(
    boss,
    "shop-inventory.low-stock-alerts",
    ["low_stock_alert_state"],
    registerLowStockAlertsJob,
  );

  // Daily 13:43 UTC — pre-build draft prescription_request_packets
  // for active Rxs expiring in the next 30 days so a CSR doesn't
  // have to hunt for them. Gated by
  // RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED=1 (off in dev/preview);
  // does NOT auto-fax — CSR reviews + sends.
  await registerPrescriptionRequestAutoDraftJob(boss);

  // Sunday 04:13 UTC — weekly orphan-assignee sweep. Unpins
  // conversations whose assignee was revoked (Team admin UI flipped
  // admin_users.status='revoked'); the conversations would otherwise
  // sit pinned to the ghost admin forever, hidden from the
  // unassigned queue.
  await registerConversationOrphanAssigneeSweepJob(boss);

  workerReady = true;
  logger.info(
    "resupply in-process worker ready (pg-boss started, reminders + attachment-sweep + smart-trigger-evaluator + smart-trigger-send + rx-renewal-send + idempotency-keys-prune + onboarding-checkins scheduled)",
  );
}

export async function stopWorker(timeoutMs = 10_000): Promise<void> {
  // The caller (index.ts shutdown) passes the remaining wall-clock
  // budget so total HTTP-drain + worker-stop stays inside the
  // orchestrator's grace window (Railway/K8s ~30s). Hard floor at
  // 1s — pg-boss needs a non-trivial timeout to avoid throwing
  // immediately when there are no in-flight jobs.
  workerReady = false;
  if (!bossInstance) return;
  const budget = Math.max(1_000, timeoutMs);
  try {
    await bossInstance.stop({ graceful: true, timeout: budget });
  } catch (err) {
    logger.error({ err }, "error stopping pg-boss");
  }
  bossInstance = null;
}
