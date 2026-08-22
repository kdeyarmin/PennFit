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

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { PLATFORM_NAME } from "../../lib/company-info";
import { logger } from "../../lib/logger";
import { notifyOpsDigest } from "../../lib/slack/notify";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
import { renderBrandedEmail, textParagraph } from "@workspace/resupply-email";

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
  const subject = `${PLATFORM_NAME} KPI alert — ${n} metric${
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

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandTagline: "Analytics",
    heading: "KPI alert",
    preheader: `${n} metric${n === 1 ? "" : "s"} crossed a threshold.`,
    contentHtml: [
      textParagraph(`${n} metric${n === 1 ? "" : "s"} crossed a threshold.`),
      `<table role="presentation" width="100%" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
<tbody>${rows}</tbody>
</table>`,
    ].join("\n"),
    footerLines: ["Triage these in the admin metric-alerts page."],
  });
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

  const orgId = await resolveSeedOrgId();
  if (!orgId) return stats;
  const supabase = getOrgScopedClient(orgId);

  const { data, error } = await supabase
    .raw()
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

  // Slack ops digest (best-effort, non-PHI: KPI metric keys + severities).
  // Fires whenever there are newly-pending alerts, independent of email config.
  void notifyOpsDigest({
    orgId: undefined,
    severity: "warning",
    title: `🟠 KPI alerts — ${rows.length} new`,
    lines: rows
      .slice(0, 10)
      .map((r) => `• \`${String(r.metric_key)}\` (${String(r.severity)})`),
  });

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

  // Fan recipients out concurrently — independent HTTP round-trips, so a
  // slow/failed send to one address must not serialize the others.
  const sendResults = await Promise.all(
    recipients.map(async (to) => {
      try {
        await sendgrid.sendEmail({ to, subject, html, text });
        return true;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err : new Error(String(err)), to },
          "metric-alerts-notify: send failed for one recipient",
        );
        return false;
      }
    }),
  );
  const anySent = sendResults.some(Boolean);
  stats.emailSent = anySent;

  // Stamp notified_at ONLY on a successful send, so a total send failure
  // leaves the alerts for the next run instead of dropping them.
  if (anySent) {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .raw()
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
