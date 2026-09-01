// pg-boss job: the lifecycle health scan.
//
// Every two hours, measure the ~27 signals in the catalog for every
// active tenant (plus the two platform-scope ones), decide what has
// CHANGED since last time, and tell somebody at most once — per tenant,
// per scan.
//
// WHY A SCAN AND NOT A STREAM
// ---------------------------
// Every signal here is a property of a POPULATION: how many cycles
// closed never-contacted this week, how much shipped product has no
// claim, how far behind the therapy sync is. None of them is an event
// you can hook. Trying to make them events is how you end up with one
// alert per patient, which is the failure mode this whole subsystem is
// shaped to avoid.
//
// WHAT IT NEVER DOES
// ------------------
// It changes nothing. No cycle closes, no flag flips, no message goes to
// a patient. The only writes are to its own two tables, and the only
// outbound traffic is a digest to staff.
//
// SUPPRESSION IS THE FEATURE
// --------------------------
// Twelve scans a day against 27 signals could produce 324 notifications
// per tenant per day. It produces at most one message per tenant per
// scan, and for an unchanged problem at most one per day — see
// `decideAlertAction`. A monitor that emails on every tick is a monitor
// whose emails have a filter rule.
//
// PHI: counts, ages, ratios, signal keys. Nothing this job reads,
// stores, logs or sends identifies a patient.

import type PgBoss from "pg-boss";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { PLATFORM_NAME } from "../../lib/company-info";
import {
  applyAlertDecision,
  decideAlertAction,
  PLATFORM_SCOPE,
  readOpenAlerts,
  recordObservation,
  renotifyHours,
  type OpenAlert,
} from "../../lib/lifecycle-health/alerts";
import {
  collectPlatformObservations,
  collectTenantObservations,
  type Observations,
} from "../../lib/lifecycle-health/collect";
import {
  renderDigest,
  type DigestItem,
} from "../../lib/lifecycle-health/digest";
import { evaluateSignal } from "../../lib/lifecycle-health/evaluate";
import {
  LIFECYCLE_SIGNALS,
  PLATFORM_SIGNALS,
  TENANT_SIGNALS,
  type LifecycleSignal,
} from "../../lib/lifecycle-health/signals";
import { logger } from "../../lib/logger";
import { notifyOpsDigest } from "../../lib/slack/notify";
import { resolveTenantBaseUrl } from "../../lib/tenant-branding";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

import { parseRecipientList } from "./metric-alerts-notify";

export const LIFECYCLE_HEALTH_SCAN_JOB = "lifecycle.health-scan";
/**
 * Every two hours at :20.
 *
 * Two hours because the tightest expectation in the catalog is a 24-hour
 * SLA and the loosest is a weekly window — a scan an hour apart would
 * measure the same numbers twice. :20 keeps it off the hour, where the
 * daily digests and sweeps already stack.
 */
const LIFECYCLE_HEALTH_SCAN_CRON = "20 */2 * * *";

const HOUR_MS = 60 * 60 * 1000;

export interface ScanScopeResult {
  scopeId: string;
  /** Signals evaluated. Always the catalog's size for the scope. */
  evaluated: number;
  failures: number;
  warnings: number;
  unknown: number;
  disabled: number;
  notConfigured: number;
  opened: number;
  escalated: number;
  renotified: number;
  suppressed: number;
  resolved: number;
  notified: boolean;
}

export interface LifecycleHealthScanStats {
  tenants: number;
  tenantsFailed: number;
  scopes: ScanScopeResult[];
}

/** Dead-letter depth — the one signal that needs a pg-boss handle. */
async function collectWorkerObservations(boss: PgBoss): Promise<Observations> {
  try {
    const queues = await boss.getQueues();
    let total = 0;
    const nonEmpty: string[] = [];
    for (const queue of queues) {
      const name = (queue as { name?: string }).name;
      if (!name || !name.endsWith(".dlq")) continue;
      const size = await boss.getQueueSize(name);
      if (size > 0) {
        total += size;
        nonEmpty.push(name);
      }
    }
    return {
      worker_failures: {
        state: "measured",
        value: total,
        detail: { queues: nonEmpty.slice(0, 10).join(", ") || "none" },
      },
    };
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_health.collector_failed",
        signal: "worker_failures",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: could not read dead-letter depth",
    );
    return {
      worker_failures: {
        state: "unknown",
        value: null,
        reason: "The dead-letter queue read failed. This is not a zero.",
      },
    };
  }
}

function openForHours(open: OpenAlert | null, nowMs: number): number | null {
  if (!open) return null;
  const t = Date.parse(open.firstObservedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

/**
 * Evaluate one scope, write its state, and return what to say about it.
 *
 * Exported for testing: the decision counts are the property worth
 * pinning, and they are unreachable through the job's registration.
 */
export async function scanScope(input: {
  scopeId: string;
  orgId: string | null;
  signals: readonly LifecycleSignal[];
  observations: Observations;
  db: ReturnType<typeof getOrgScopedClient>;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ result: ScanScopeResult; items: DigestItem[] }> {
  const { scopeId, orgId, signals, observations, db, nowMs } = input;
  const env = input.env ?? process.env;
  const nowIso = new Date(nowMs).toISOString();

  let open: Map<string, OpenAlert>;
  try {
    open = await readOpenAlerts(db, scopeId);
  } catch (err) {
    // Without the open set every alerting signal would look brand new
    // and everybody would be told again. Skipping the scope is the
    // quieter wrong answer, and the next scan retries.
    logger.warn(
      {
        event: "lifecycle_health.open_alerts_unreadable",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: could not read open alerts; skipping this scope rather than re-notifying everything",
    );
    throw err;
  }

  const result: ScanScopeResult = {
    scopeId,
    evaluated: 0,
    failures: 0,
    warnings: 0,
    unknown: 0,
    disabled: 0,
    notConfigured: 0,
    opened: 0,
    escalated: 0,
    renotified: 0,
    suppressed: 0,
    resolved: 0,
    notified: false,
  };
  const items: DigestItem[] = [];
  const quietHours = renotifyHours(env);

  for (const signal of signals) {
    const observation = observations[signal.key] ?? {
      state: "unknown" as const,
      value: null,
      reason: "No reading was taken for this signal in this scan.",
    };
    const evaluation = evaluateSignal(signal, observation, env);
    result.evaluated += 1;
    switch (evaluation.status) {
      case "failure":
        result.failures += 1;
        break;
      case "warning":
        result.warnings += 1;
        break;
      case "unknown":
        result.unknown += 1;
        break;
      case "disabled":
        result.disabled += 1;
        break;
      case "not_configured":
        result.notConfigured += 1;
        break;
    }

    const existing = open.get(signal.key) ?? null;
    const decision = decideAlertAction({
      open: existing,
      evaluation,
      nowMs,
      renotifyHours: quietHours,
    });

    switch (decision.action) {
      case "open":
        result.opened += 1;
        break;
      case "escalate":
        result.escalated += 1;
        break;
      case "renotify":
        result.renotified += 1;
        break;
      case "suppress":
        result.suppressed += 1;
        break;
      case "resolve":
        result.resolved += 1;
        break;
    }

    try {
      await applyAlertDecision({
        db,
        scopeId,
        orgId,
        evaluation,
        decision,
        open: existing,
        nowIso,
      });
    } catch (err) {
      logger.warn(
        {
          event: "lifecycle_health.alert_write_failed",
          signal: signal.key,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "lifecycle-health: could not persist an alert transition",
      );
    }

    try {
      await recordObservation({ db, scopeId, orgId, evaluation, nowIso });
    } catch (err) {
      logger.warn(
        {
          event: "lifecycle_health.observation_write_failed",
          signal: signal.key,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "lifecycle-health: could not persist an observation",
      );
    }

    if (decision.notify) {
      items.push({
        signal,
        evaluation,
        decision,
        openForHours: openForHours(existing, nowMs),
      });
    }

    // One structured event per STATE CHANGE, not one per signal per
    // scan: 27 signals × 12 scans × N tenants of "still fine" is a log
    // bill and a haystack. A change is the thing worth finding later.
    if (decision.notify || decision.action === "deescalate") {
      logger.info(
        {
          event: `lifecycle_health.alert_${decision.action}`,
          signal: signal.key,
          severity: signal.severity,
          status: evaluation.status,
          value: evaluation.value,
          threshold:
            evaluation.status === "failure"
              ? evaluation.failThreshold
              : evaluation.warnThreshold,
          sample: evaluation.sample,
          truncated: evaluation.truncated,
          scope: scopeId === PLATFORM_SCOPE ? "platform" : "tenant",
        },
        `lifecycle-health: ${signal.key} ${decision.action}`,
      );
    }
  }

  return { result, items };
}

async function notifyScope(input: {
  scopeLabel: string;
  orgId: string | null;
  items: DigestItem[];
}): Promise<boolean> {
  const { scopeLabel, orgId, items } = input;
  if (items.length === 0) return false;

  const baseUrl = orgId
    ? await resolveTenantBaseUrl(orgId).catch(() => "")
    : "";
  const consoleUrl = `${baseUrl || ""}/admin/operations`;
  const digest = renderDigest({
    scopeLabel,
    items,
    consoleUrl,
    platformName: PLATFORM_NAME,
  });

  const worstIsFailure = items.some(
    (i) => i.evaluation.status === "failure" && i.decision.action !== "resolve",
  );
  void notifyOpsDigest({
    orgId: orgId ?? undefined,
    severity: worstIsFailure ? "critical" : "warning",
    title: digest.subject,
    lines: digest.lines.slice(0, 12),
  });

  // Internal ops mail stays on the PLATFORM sender by design (see
  // CLAUDE.md): this is staff correspondence about the platform's own
  // health, not patient-facing tenant mail.
  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  if (recipients.length === 0) return false;

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        { event: "lifecycle_health.email_unconfigured", items: items.length },
        "lifecycle-health: findings to report but email is not configured",
      );
      return false;
    }
    throw err;
  }

  const results = await Promise.all(
    recipients.map(async (to) => {
      try {
        await sendgrid.sendEmail({
          to,
          subject: digest.subject,
          html: digest.html,
          text: digest.text,
        });
        return true;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err : new Error(String(err)), to },
          "lifecycle-health: send failed for one recipient",
        );
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

export async function runLifecycleHealthScan(
  boss: PgBoss,
  options: { nowMs?: number } = {},
): Promise<LifecycleHealthScanStats> {
  const nowMs = options.nowMs ?? Date.now();
  const stats: LifecycleHealthScanStats = {
    tenants: 0,
    tenantsFailed: 0,
    scopes: [],
  };

  const workerObservations = await collectWorkerObservations(boss);

  const fanOut = await forEachActiveOrg(
    async (orgId) => {
      const observations = await collectTenantObservations(orgId, {
        nowMs,
        extra: workerObservations,
      });
      const { result, items } = await scanScope({
        scopeId: orgId,
        orgId,
        signals: TENANT_SIGNALS,
        observations,
        db: getOrgScopedClient(orgId),
        nowMs,
      });
      result.notified = await notifyScope({
        scopeLabel: `Tenant ${orgId.slice(0, 8)}`,
        orgId,
        items,
      });
      stats.scopes.push(result);
    },
    { jobName: LIFECYCLE_HEALTH_SCAN_JOB },
  );
  stats.tenants = fanOut.total;
  stats.tenantsFailed = fanOut.failedOrgIds.length;

  // Platform scope: rows that belong to no tenant. Evaluated once.
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (seedOrgId) {
      const observations = await collectPlatformObservations({
        nowMs,
        seedOrgId,
      });
      const { result, items } = await scanScope({
        scopeId: PLATFORM_SCOPE,
        orgId: null,
        signals: PLATFORM_SIGNALS,
        observations,
        db: getOrgScopedClient(seedOrgId),
        nowMs,
      });
      result.notified = await notifyScope({
        scopeLabel: "Platform (no tenant)",
        orgId: null,
        items,
      });
      stats.scopes.push(result);
    }
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_health.platform_scope_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: the platform-scope pass failed",
    );
  }

  return stats;
}

export async function registerLifecycleHealthScanJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    LIFECYCLE_HEALTH_SCAN_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(LIFECYCLE_HEALTH_SCAN_JOB, async () => {
    try {
      const stats = await runLifecycleHealthScan(boss);
      logger.info(
        {
          event: "lifecycle_health.scan_completed",
          tenants: stats.tenants,
          tenantsFailed: stats.tenantsFailed,
          scopes: stats.scopes.length,
          signals: LIFECYCLE_SIGNALS.length,
          opened: stats.scopes.reduce((n, s) => n + s.opened, 0),
          escalated: stats.scopes.reduce((n, s) => n + s.escalated, 0),
          resolved: stats.scopes.reduce((n, s) => n + s.resolved, 0),
          suppressed: stats.scopes.reduce((n, s) => n + s.suppressed, 0),
          notified: stats.scopes.filter((s) => s.notified).length,
        },
        "lifecycle-health: scan completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "lifecycle-health: scan failed",
      );
      throw err;
    }
  });
  await boss.schedule(LIFECYCLE_HEALTH_SCAN_JOB, LIFECYCLE_HEALTH_SCAN_CRON);
  logger.info(
    { queue: LIFECYCLE_HEALTH_SCAN_JOB, cron: LIFECYCLE_HEALTH_SCAN_CRON },
    "lifecycle-health scan worker registered",
  );
}
