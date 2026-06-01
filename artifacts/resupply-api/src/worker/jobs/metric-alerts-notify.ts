// pg-boss job: email a digest of newly-fired KPI alerts to admin staff
// (migration 0194 / roadmap F2 — the "push" half of the alert substrate).
//
// Runs a few minutes after the metrics.alerts-evaluator. Sweeps
// metric_alerts that are still open AND not yet notified, emails ONE
// digest to RESUPPLY_ADMIN_EMAILS via the shared SendGrid client, and
// stamps notified_at — but ONLY on a successful send, so a transient
// email failure (or an un-configured environment) leaves the alerts for
// the next run rather than silently dropping the notification.
//
// Fail-soft, like the low-stock digest: no recipients OR email not
// configured → log + exit-0 (a half-configured dev/preview environment
// should never page anyone or crash the worker).

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

export const METRIC_ALERTS_NOTIFY_JOB = "metrics.alerts-notify";
const METRIC_ALERTS_NOTIFY_CRON = "50 6 * * *"; // 5 min after the evaluator

export function parseRecipientList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("@"));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function severityColor(severity: string): string {
  if (severity === "critical") return "#b91c1c";
  if (severity === "warning") return "#b45309";
  return "#6b7280";
}

export interface NotifiableAlert {
  id: string;
  metricKey: string;
  severity: string;
  message: string;
}

/** Render the digest email. Pure + exported for testing. */
export function renderAlertDigest(alerts: NotifiableAlert[]): {
  subject: string;
  html: string;
  text: string;
} {
  const n = alerts.length;
  const subject = `PennPaps KPI alert — ${n} metric${
    n === 1 ? "" : "s"
  } need attention`;

  const text = [
    `${n} metric alert${n === 1 ? "" : "s"} fired:`,
    "",
    ...alerts.map((a) => `  • [${a.severity}] ${a.message}`),
    "",
    "Triage: /admin/metric-alerts",
  ].join("\n");

  const rows = alerts
    .map(
      (a) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:${severityColor(
            a.severity,
          )};text-transform:uppercase;font-size:11px;">${escapeHtml(
            a.severity,
          )}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(
            a.message,
          )}</td>
        </tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;margin:0;padding:24px;">
  <table style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;border-collapse:collapse;">
    <tr><td style="padding:20px 24px;background:#0a1f44;color:#ffffff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">KPI alert</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#cbd5e1;">${n} metric${
        n === 1 ? "" : "s"
      } crossed a threshold</p>
    </td></tr>
    <tr><td style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;color:#6b7280;">
      Triage these in the admin metric-alerts page.
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}

export interface MetricAlertsNotifyStats {
  pending: number;
  recipients: number;
  emailSent: boolean;
  notified: number;
}

export async function runMetricAlertsNotify(): Promise<MetricAlertsNotifyStats> {
  const stats: MetricAlertsNotifyStats = {
    pending: 0,
    recipients: 0,
    emailSent: false,
    notified: 0,
  };

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("metric_alerts")
    .select("id, metric_key, severity, message")
    .is("notified_at", null)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  stats.pending = rows.length;
  if (rows.length === 0) return stats;

  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  stats.recipients = recipients.length;
  if (recipients.length === 0) {
    logger.info(
      { event: "metrics.alerts-notify.no_recipients", pending: rows.length },
      "metric-alerts-notify: RESUPPLY_ADMIN_EMAILS empty; leaving alerts un-notified",
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
          event: "metrics.alerts-notify.email_unconfigured",
          message: err.message,
        },
        "metric-alerts-notify: email not configured; leaving alerts un-notified",
      );
      return stats;
    }
    throw err;
  }

  const alerts: NotifiableAlert[] = rows.map((r) => ({
    id: String(r.id),
    metricKey: String(r.metric_key),
    severity: String(r.severity),
    message: String(r.message),
  }));
  const { subject, html, text } = renderAlertDigest(alerts);

  let anySent = false;
  for (const to of recipients) {
    try {
      await sendgrid.sendEmail({ to, subject, html, text });
      anySent = true;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, to },
        "metric-alerts-notify: send failed for one recipient",
      );
    }
  }
  stats.emailSent = anySent;

  // Stamp notified_at ONLY on a successful send, so a total send failure
  // leaves the alerts for the next run instead of dropping them.
  if (anySent) {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .schema("resupply")
      .from("metric_alerts")
      .update({ notified_at: nowIso, updated_at: nowIso })
      .in(
        "id",
        alerts.map((a) => a.id),
      );
    if (upErr) {
      logger.warn(
        { err: upErr.message },
        "metric-alerts-notify: notified_at stamp failed (will retry next run)",
      );
    } else {
      stats.notified = alerts.length;
    }
  }

  return stats;
}

export async function registerMetricAlertsNotifyJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    METRIC_ALERTS_NOTIFY_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(METRIC_ALERTS_NOTIFY_JOB, async () => {
    try {
      const stats = await runMetricAlertsNotify();
      logger.info(
        { event: "metrics.alerts-notify.completed", ...stats },
        "metric-alerts-notify: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "metric-alerts-notify: failed",
      );
      throw err;
    }
  });
  await boss.schedule(METRIC_ALERTS_NOTIFY_JOB, METRIC_ALERTS_NOTIFY_CRON);
  logger.info(
    { queue: METRIC_ALERTS_NOTIFY_JOB, cron: METRIC_ALERTS_NOTIFY_CRON },
    "metrics alerts-notify worker registered",
  );
}
