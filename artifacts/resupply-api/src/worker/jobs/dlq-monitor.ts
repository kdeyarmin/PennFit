// pg-boss job: daily dead-letter-queue depth report to admin staff.
//
// Every queue in this worker routes exhausted jobs to a per-queue DLQ
// ("<queue>.dlq" — see worker/lib/queue-options.ts), but until this
// job existed NOTHING watched those queues: a reminder, autopay, or
// claim job that burned through its retry budget sat in its DLQ
// silently until someone noticed the business effect. This job closes
// that loop (whole-app review 2026-06-12, recommendation B1).
//
// Mechanics: enumerate queues via pg-boss's own API (no raw pg — the
// pgboss_resupply schema stays an implementation detail), count the
// queued jobs in every "*.dlq" queue, and email ONE digest of the
// non-empty ones to RESUPPLY_ADMIN_EMAILS via the shared SendGrid
// client. Stateless by design: a non-empty DLQ re-notifies on every
// daily run until ops drains it — an outstanding-failure report, same
// posture as the low-stock digest.
//
// Fail-soft: no recipients OR email not configured → log + exit 0 (a
// half-configured dev/preview environment must never page anyone or
// crash the worker). Counts and queue names only — no payloads, no
// PHI.

import type PgBoss from "pg-boss";

import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

import { parseRecipientList } from "./metric-alerts-notify";

export const DLQ_MONITOR_JOB = "worker.dlq-monitor";
// After the metric-alert pipeline (06:45 evaluate / 06:50 notify) so
// the two morning digests arrive together.
const DLQ_MONITOR_CRON = "55 6 * * *";

export interface DlqDepth {
  /** DLQ queue name, e.g. "reminders.scan.dlq". */
  queue: string;
  /** Jobs currently sitting in the DLQ awaiting review. */
  count: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the digest email. Pure + exported for testing. */
export function renderDlqDigest(depths: DlqDepth[]): {
  subject: string;
  html: string;
  text: string;
} {
  const total = depths.reduce((sum, d) => sum + d.count, 0);
  const subject = `PennPaps worker alert — ${total} dead-lettered job${
    total === 1 ? "" : "s"
  } need review`;

  const text = [
    `${total} job${total === 1 ? "" : "s"} exhausted retries and landed in a dead-letter queue:`,
    "",
    ...depths.map((d) => `  • ${d.queue}: ${d.count}`),
    "",
    "Inspect: select * from pgboss_resupply.job where name = '<queue>.dlq'",
    "Runbook: docs/runbooks/worker-recovery.md",
  ].join("\n");

  const rows = depths
    .map(
      (d) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(
            d.queue,
          )}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${d.count}</td>
        </tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;margin:0;padding:24px;">
  <table style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;border-collapse:collapse;">
    <tr><td style="padding:20px 24px;background:#7f1d1d;color:#ffffff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">Dead-lettered jobs</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#fecaca;">${total} job${
        total === 1 ? "" : "s"
      } exhausted retries and need${total === 1 ? "s" : ""} review</p>
    </td></tr>
    <tr><td style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;color:#6b7280;">
      These jobs will NOT retry on their own. See docs/runbooks/worker-recovery.md.
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}

/**
 * Enumerate every "*.dlq" queue and return the non-empty ones,
 * sorted deepest-first. Exported for testing against a stub boss.
 */
export async function collectDlqDepths(
  boss: Pick<PgBoss, "getQueues" | "getQueueSize">,
): Promise<DlqDepth[]> {
  const queues = await boss.getQueues();
  const dlqNames = queues
    .map((q) => q.name)
    .filter((name) => name.endsWith(".dlq"));

  const depths: DlqDepth[] = [];
  for (const queue of dlqNames) {
    const count = await boss.getQueueSize(queue);
    if (count > 0) depths.push({ queue, count });
  }
  depths.sort((a, b) => b.count - a.count || a.queue.localeCompare(b.queue));
  return depths;
}

export interface DlqMonitorStats {
  dlqQueues: number;
  nonEmpty: number;
  totalDead: number;
  recipients: number;
  emailSent: boolean;
}

export async function runDlqMonitor(
  boss: Pick<PgBoss, "getQueues" | "getQueueSize">,
): Promise<DlqMonitorStats> {
  const queues = await boss.getQueues();
  const dlqCount = queues.filter((q) => q.name.endsWith(".dlq")).length;
  const depths = await collectDlqDepths(boss);

  const stats: DlqMonitorStats = {
    dlqQueues: dlqCount,
    nonEmpty: depths.length,
    totalDead: depths.reduce((sum, d) => sum + d.count, 0),
    recipients: 0,
    emailSent: false,
  };
  if (depths.length === 0) return stats;

  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  stats.recipients = recipients.length;
  if (recipients.length === 0) {
    logger.warn(
      {
        event: "worker.dlq-monitor.no_recipients",
        nonEmpty: depths.length,
        totalDead: stats.totalDead,
      },
      "dlq-monitor: dead-lettered jobs found but RESUPPLY_ADMIN_EMAILS is empty",
    );
    return stats;
  }

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        {
          event: "worker.dlq-monitor.email_unconfigured",
          nonEmpty: depths.length,
          totalDead: stats.totalDead,
        },
        "dlq-monitor: dead-lettered jobs found but email is not configured",
      );
      return stats;
    }
    throw err;
  }

  const { subject, html, text } = renderDlqDigest(depths);
  const sendResults = await Promise.all(
    recipients.map(async (to) => {
      try {
        await sendgrid.sendEmail({ to, subject, html, text });
        return true;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err : new Error(String(err)), to },
          "dlq-monitor: send failed for one recipient",
        );
        return false;
      }
    }),
  );
  stats.emailSent = sendResults.some(Boolean);
  return stats;
}

export async function registerDlqMonitorJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, DLQ_MONITOR_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(DLQ_MONITOR_JOB, async () => {
    try {
      const stats = await runDlqMonitor(boss);
      logger.info(
        { event: "worker.dlq-monitor.completed", ...stats },
        "dlq-monitor: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "dlq-monitor: failed",
      );
      throw err;
    }
  });
  await boss.schedule(DLQ_MONITOR_JOB, DLQ_MONITOR_CRON);
  logger.info(
    { queue: DLQ_MONITOR_JOB, cron: DLQ_MONITOR_CRON },
    "dlq-monitor worker registered",
  );
}
