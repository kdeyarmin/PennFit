// pg-boss job: watch for a SPIKE in failed outbound patient messages and
// ping the CS reps in Slack so a bouncing sender / bad number batch gets
// caught in minutes, not whenever someone opens /admin/delivery-failures.
//
// Why a windowed sweep (no dedup state table):
//   The SMS/email status callbacks stamp messages.delivery_status to a
//   failure value asynchronously. Alerting per-message would be noisy, and a
//   running counter would reset on deploy. Instead this runs every 15 min and
//   counts failures whose row was CREATED in the last 15 min — a roughly
//   non-overlapping window, so each failure is counted at most once and an
//   alert fires at most once per window. A persistent spike re-alerts each
//   window (it's still spiking — that's the point).
//
// Tenant scoping: `messages` is per-tenant, so the sweep fans out across
// active orgs and evaluates each tenant's own threshold independently.
//
// Fail-soft: the only side effect is a best-effort Slack post
// (notifyDeliveryFailureSpike never throws); with Slack unconfigured the job
// is a cheap count that posts nothing. Threshold is env-tunable.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { notifyDeliveryFailureSpike } from "../../lib/slack/notify";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const MONITOR_JOB = "messaging.delivery-failure-monitor";
const MONITOR_CRON = "*/15 * * * *";
const WINDOW_MINUTES = 15;

// Same failure taxonomy the /admin/delivery-failures queue surfaces.
const FAILURE_STATUSES = [
  "failed",
  "undelivered",
  "bounced",
  "dropped",
  "rejected",
  "spam_report",
] as const;

const DEFAULT_THRESHOLD = 5;

/** Failures-per-window that trip an alert. Env-tunable; clamped to >= 1. */
export function deliveryFailureThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(
    env.RESUPPLY_DELIVERY_FAILURE_ALERT_THRESHOLD ?? "",
    10,
  );
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_THRESHOLD;
  return raw;
}

export interface DeliveryFailureMonitorResult {
  count: number;
  alerted: boolean;
}

/** One tenant's window check. Exported for test injection. */
export async function runDeliveryFailureMonitorForOrg(
  orgId: string,
): Promise<DeliveryFailureMonitorResult> {
  const supabase = getOrgScopedClient(orgId);
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .in("delivery_status", FAILURE_STATUSES as unknown as string[])
    .gte("created_at", since);
  if (error) throw error;

  const n = count ?? 0;
  if (n >= deliveryFailureThreshold()) {
    void notifyDeliveryFailureSpike({
      orgId,
      count: n,
      windowMinutes: WINDOW_MINUTES,
    });
    return { count: n, alerted: true };
  }
  return { count: n, alerted: false };
}

/** Fan the window check across every active tenant. */
export async function runDeliveryFailureMonitor(): Promise<void> {
  await forEachActiveOrg(
    async (orgId) => {
      const { count, alerted } = await runDeliveryFailureMonitorForOrg(orgId);
      if (alerted) {
        logger.warn(
          {
            event: "messaging.delivery-failure-monitor.spike",
            org_id: orgId,
            count,
            window_minutes: WINDOW_MINUTES,
          },
          "delivery-failure-monitor: spike detected — alerted",
        );
      }
    },
    { jobName: MONITOR_JOB },
  );
}

export async function registerDeliveryFailureMonitorJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, MONITOR_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(MONITOR_JOB, async () => {
    try {
      await runDeliveryFailureMonitor();
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "delivery-failure-monitor: failed",
      );
      throw err;
    }
  });
  await boss.schedule(MONITOR_JOB, MONITOR_CRON);
  logger.info(
    { queue: MONITOR_JOB, cron: MONITOR_CRON },
    "delivery-failure-monitor scheduled",
  );
}
