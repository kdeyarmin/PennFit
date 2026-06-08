// pg-boss job: email the owner a weekly digest — this-week vs prior-week
// movement on the headline KPIs (from the F2 metrics_daily snapshot) plus
// the single biggest open alert (Owner #6, Phase 2).
//
// Deterministic numbers digest (no LLM): a KPI email wants exact figures,
// and keeping it model-free means the weekly send never depends on an AI
// vendor key or a flaky completion. (A Claude narrative over these numbers
// is an easy future enhancement — see the roadmap.) Fail-soft like the
// metric-alerts-notify job: missing SendGrid config or empty
// RESUPPLY_ADMIN_EMAILS → log + return, never throw / never block.
//
// PHI posture: metrics_daily + metric_alerts are aggregate KPI data
// (counts / dollars / ratios), no patient identifiers — safe to email to
// the owner distribution.

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

export const OWNER_DIGEST_JOB = "owner.weekly-digest";
// Mondays 13:00 UTC — Monday morning in the US, after the weekend's
// snapshots have landed.
const OWNER_DIGEST_CRON = "0 13 * * 1";

export type MetricUnit = "count" | "cents" | "ratio" | "pct" | "days";

export interface DigestMetricRow {
  metricKey: string;
  metricDate: string; // YYYY-MM-DD
  metricValue: number;
}

export interface DigestAlertRow {
  severity: string;
  metricKey: string;
  metricDate: string;
  message: string;
}

export interface DigestMetric {
  metricKey: string;
  label: string;
  unit: MetricUnit;
  thisWeek: number;
  priorWeek: number;
  /** (this − prior) ÷ prior; null when prior is 0 (undefined growth). */
  deltaPct: number | null;
}

export interface OwnerDigest {
  windowStart: string;
  windowEnd: string;
  metrics: DigestMetric[];
  topAlert: { severity: string; metricKey: string; message: string } | null;
  /** True when there's any movement or any alert worth emailing. */
  hasData: boolean;
}

// The KPIs the snapshot writes today, in digest display order. New
// metrics_daily keys can be added here as the snapshot grows.
const METRICS: ReadonlyArray<{ key: string; label: string; unit: MetricUnit }> =
  [
    { key: "revenue_net_cents", label: "Net revenue", unit: "cents" },
    { key: "revenue_gross_cents", label: "Gross revenue", unit: "cents" },
    { key: "orders_paid_count", label: "Paid orders", unit: "count" },
    { key: "revenue_refunded_cents", label: "Refunds", unit: "cents" },
  ];

const SEVERITY_RANK: Record<string, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

function dateMinusDays(asOfMs: number, days: number): string {
  return new Date(asOfMs - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Pure: fold the last two weeks of daily metrics into per-KPI
 * this-week / prior-week sums + delta, and pick the single highest-
 * priority open alert. No I/O — unit-tested directly.
 */
export function buildOwnerDigest(
  rows: readonly DigestMetricRow[],
  alerts: readonly DigestAlertRow[],
  asOf?: string,
): OwnerDigest {
  const asOfMs = asOf ? Date.parse(asOf) : Date.now();
  const base = Number.isNaN(asOfMs) ? Date.now() : asOfMs;
  const windowEnd = dateMinusDays(base, 0); // exclusive upper bound
  const thisWeekStart = dateMinusDays(base, 7);
  const priorWeekStart = dateMinusDays(base, 14);

  const sumInRange = (key: string, lo: string, hiExcl: string): number =>
    rows.reduce(
      (s, r) =>
        r.metricKey === key && r.metricDate >= lo && r.metricDate < hiExcl
          ? s + (Number.isFinite(r.metricValue) ? r.metricValue : 0)
          : s,
      0,
    );

  const metrics: DigestMetric[] = METRICS.map((m) => {
    const thisWeek = sumInRange(m.key, thisWeekStart, windowEnd);
    const priorWeek = sumInRange(m.key, priorWeekStart, thisWeekStart);
    const deltaPct =
      priorWeek !== 0 ? (thisWeek - priorWeek) / priorWeek : null;
    return {
      metricKey: m.key,
      label: m.label,
      unit: m.unit,
      thisWeek,
      priorWeek,
      deltaPct,
    };
  });

  let topAlert: OwnerDigest["topAlert"] = null;
  let bestRank = -1;
  let bestDate = "";
  for (const a of alerts) {
    const rank = SEVERITY_RANK[a.severity] ?? 0;
    if (rank > bestRank || (rank === bestRank && a.metricDate > bestDate)) {
      bestRank = rank;
      bestDate = a.metricDate;
      topAlert = {
        severity: a.severity,
        metricKey: a.metricKey,
        message: a.message,
      };
    }
  }

  const hasData =
    metrics.some((m) => m.thisWeek !== 0 || m.priorWeek !== 0) ||
    alerts.length > 0;

  return { windowStart: thisWeekStart, windowEnd, metrics, topAlert, hasData };
}

function fmtValue(value: number, unit: MetricUnit): string {
  if (unit === "cents")
    return (value / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  if (unit === "count") return Math.round(value).toLocaleString();
  return value.toLocaleString();
}

function fmtDelta(deltaPct: number | null): string {
  if (deltaPct == null) return "(no prior-week baseline)";
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "▬";
  return `${arrow} ${Math.abs(deltaPct * 100).toFixed(0)}% vs prior week`;
}

/** Pure: render the digest to a plain-text email body. */
export function formatDigestText(digest: OwnerDigest): string {
  const lines = [
    `PennFit weekly owner digest — week of ${digest.windowStart}`,
    "",
  ];
  for (const m of digest.metrics) {
    lines.push(
      `${m.label}: ${fmtValue(m.thisWeek, m.unit)} this week  ${fmtDelta(m.deltaPct)}`,
    );
  }
  lines.push("");
  lines.push(
    digest.topAlert
      ? `Biggest fire: [${digest.topAlert.severity.toUpperCase()}] ${digest.topAlert.metricKey} — ${digest.topAlert.message}`
      : "No open KPI alerts. 🎉",
  );
  lines.push("");
  lines.push(
    "Dashboards: /admin/analytics/margin · /admin/billing/payer-profitability · /admin/goals · /admin/kpi-alerts",
  );
  return lines.join("\n");
}

export function parseRecipientList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("@"));
}

type Sendgrid = ReturnType<typeof createSendgridClient>;

interface DigestDeps {
  sendEmail?: (
    client: Sendgrid,
    recipients: string[],
    subject: string,
    body: string,
  ) => Promise<void>;
}

export interface OwnerDigestResult {
  hasData: boolean;
  emailed: number;
  skippedNoSendgrid: boolean;
  skippedNoRecipients: boolean;
}

export async function runOwnerDigest(
  deps: DigestDeps = {},
): Promise<OwnerDigestResult> {
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = dateMinusDays(Date.now(), 14);

  const [metricsRes, alertsRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("metrics_daily")
      .select("metric_key, metric_date, metric_value")
      .gte("metric_date", cutoff)
      .limit(5000),
    supabase
      .schema("resupply")
      .from("metric_alerts")
      .select("severity, metric_key, metric_date, message, status")
      .eq("status", "open")
      .limit(200),
  ]);
  if (metricsRes.error) throw metricsRes.error;
  if (alertsRes.error) throw alertsRes.error;

  const digest = buildOwnerDigest(
    ((metricsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      metricKey: String(r.metric_key ?? ""),
      metricDate: String(r.metric_date ?? ""),
      metricValue: typeof r.metric_value === "number" ? r.metric_value : 0,
    })),
    ((alertsRes.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
      severity: String(a.severity ?? "info"),
      metricKey: String(a.metric_key ?? ""),
      metricDate: String(a.metric_date ?? ""),
      message: String(a.message ?? ""),
    })),
  );

  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  if (recipients.length === 0) {
    logger.info(
      { event: "owner_digest.no_recipients" },
      "owner.weekly-digest: RESUPPLY_ADMIN_EMAILS empty; skipping",
    );
    return {
      hasData: digest.hasData,
      emailed: 0,
      skippedNoSendgrid: false,
      skippedNoRecipients: true,
    };
  }

  let sendgrid: Sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.info(
        { event: "owner_digest.email_unconfigured", message: err.message },
        "owner.weekly-digest: email not configured; skipping send",
      );
      return {
        hasData: digest.hasData,
        emailed: 0,
        skippedNoSendgrid: true,
        skippedNoRecipients: false,
      };
    }
    throw err;
  }

  const sendImpl = deps.sendEmail ?? sendDigestEmail;
  await sendImpl(
    sendgrid,
    recipients,
    `PennFit weekly digest — week of ${digest.windowStart}`,
    formatDigestText(digest),
  );

  return {
    hasData: digest.hasData,
    emailed: recipients.length,
    skippedNoSendgrid: false,
    skippedNoRecipients: false,
  };
}

function textToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111827;white-space:pre-wrap;">${escaped}</pre>`;
}

async function sendDigestEmail(
  sendgrid: Sendgrid,
  recipients: string[],
  subject: string,
  body: string,
): Promise<void> {
  const html = textToHtml(body);
  // Per-recipient send (the shared client validates a single `to`), but
  // fan the recipients out concurrently — each is an independent HTTP
  // round-trip and one slow/failed send must not serialize the rest.
  await Promise.all(
    recipients.map(async (to) => {
      try {
        await sendgrid.sendEmail({ to, subject, html, text: body });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, to },
          "owner.weekly-digest: send failed for one recipient",
        );
      }
    }),
  );
}

export async function registerOwnerDigestJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, OWNER_DIGEST_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(OWNER_DIGEST_JOB, async () => {
    try {
      const stats = await runOwnerDigest();
      logger.info(
        { event: "owner_digest.completed", ...stats },
        "owner.weekly-digest: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "owner.weekly-digest: failed",
      );
      throw err;
    }
  });
  await boss.schedule(OWNER_DIGEST_JOB, OWNER_DIGEST_CRON);
  logger.info(
    { queue: OWNER_DIGEST_JOB, cron: OWNER_DIGEST_CRON },
    "owner weekly-digest worker registered",
  );
}
