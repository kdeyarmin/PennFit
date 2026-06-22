// pg-boss job: ADR deadline alert digest.
//
// The audit-response queue lives or dies by the 30-day clock. This job emails
// the operator(s) a daily digest of ADRs that are OVERDUE or AT RISK (deadline
// within the at-risk window), so a looming deadline can't slip by unseen. It
// is the active counterpart to the passive sla-sweep cache refresh.
//
// Posture
// -------
// Per-tenant fan-out, gated by the billing.adr_queue flag (no-op when off).
// OPT-IN cron (ADR_ALERT_DIGEST_CRON): the job is registered but only fires on
// a schedule once that env var is set — so enabling the queue never starts
// sending email on its own. Recipients come from RESUPPLY_ADMIN_EMAILS;
// missing recipients or unconfigured SendGrid → log + skip, never throw.
//
// PHI: the digest lists contractor / payer / deadline / days-out only — never
// patient names or any clinical content.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import { classifyAdrSla } from "@workspace/resupply-domain";

import { PLATFORM_NAME } from "../../lib/company-info";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const JOB = "billing.adr-alert-digest";
const CRON = process.env.ADR_ALERT_DIGEST_CRON?.trim();

export interface AdrAlertDigestStats {
  emailed: number;
  overdue: number;
  atRisk: number;
}

/** Comma/space/newline-separated recipient list → trimmed non-empty emails. */
export function parseRecipientList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface OpenAdr {
  contractor_name: string | null;
  payer_name: string | null;
  source: string;
  response_due: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build the plain-text digest body. No PHI — operational fields only. */
export function formatAdrDigest(
  overdue: Array<{ label: string; daysOut: number | null }>,
  atRisk: Array<{ label: string; daysOut: number | null }>,
): string {
  const lines: string[] = [];
  lines.push(`${PLATFORM_NAME} — ADR deadline digest`);
  lines.push("");
  lines.push(`Overdue: ${overdue.length}   At risk: ${atRisk.length}`);
  if (overdue.length > 0) {
    lines.push("");
    lines.push("OVERDUE (respond immediately):");
    for (const a of overdue) {
      lines.push(
        `  • ${a.label}${a.daysOut != null ? ` (${a.daysOut}d)` : ""}`,
      );
    }
  }
  if (atRisk.length > 0) {
    lines.push("");
    lines.push("AT RISK (deadline approaching):");
    for (const a of atRisk) {
      lines.push(
        `  • ${a.label}${a.daysOut != null ? ` (${a.daysOut}d)` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("Open the ADR worklist (Billing → ADR / audit response) to act.");
  return lines.join("\n");
}

function labelFor(a: OpenAdr): string {
  const who = a.contractor_name ?? a.source.toUpperCase();
  const payer = a.payer_name ? ` / ${a.payer_name}` : "";
  const due = a.response_due ? ` — due ${a.response_due}` : "";
  return `${who}${payer}${due}`;
}

export async function runAdrAlertDigestForOrg(
  orgId: string,
): Promise<AdrAlertDigestStats> {
  const stats: AdrAlertDigestStats = { emailed: 0, overdue: 0, atRisk: 0 };
  if (!(await isFeatureEnabled("billing.adr_queue", orgId))) return stats;
  const supabase = getOrgScopedClient(orgId);
  const today = todayIso();

  const { data } = await supabase
    .from("claim_adr_requests")
    .select("contractor_name, payer_name, source, response_due")
    .in("status", ["open", "in_progress"])
    .limit(1000);
  const rows = (data ?? []) as OpenAdr[];

  const overdue: Array<{ label: string; daysOut: number | null }> = [];
  const atRisk: Array<{ label: string; daysOut: number | null }> = [];
  for (const a of rows) {
    const cls = classifyAdrSla(a.response_due, today, { decided: false });
    if (cls.status === "overdue") {
      overdue.push({ label: labelFor(a), daysOut: cls.daysOut });
    } else if (cls.status === "at_risk") {
      atRisk.push({ label: labelFor(a), daysOut: cls.daysOut });
    }
  }
  stats.overdue = overdue.length;
  stats.atRisk = atRisk.length;
  if (overdue.length === 0 && atRisk.length === 0) return stats;

  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  if (recipients.length === 0) {
    logger.info(
      { event: "adr_alert_digest.no_recipients" },
      "billing.adr-alert-digest: RESUPPLY_ADMIN_EMAILS empty; skipping send",
    );
    return stats;
  }

  let sendgrid: ReturnType<typeof createSendgridClient>;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.info(
        { event: "adr_alert_digest.email_unconfigured" },
        "billing.adr-alert-digest: email not configured; skipping send",
      );
      return stats;
    }
    throw err;
  }

  const body = formatAdrDigest(overdue, atRisk);
  const subject = `ADR deadlines — ${overdue.length} overdue, ${atRisk.length} at risk`;
  await Promise.all(
    recipients.map((to) =>
      sendgrid
        .sendEmail({
          to,
          subject,
          text: body,
          html: body
            .split("\n")
            .map((l) => `<p>${escapeHtml(l)}</p>`)
            .join(""),
        })
        .catch((err: unknown) =>
          logger.warn(
            { err, event: "adr_alert_digest.send_failed" },
            "billing.adr-alert-digest: one recipient failed",
          ),
        ),
    ),
  );
  stats.emailed = recipients.length;
  return stats;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runAdrAlertDigest(): Promise<AdrAlertDigestStats> {
  const stats: AdrAlertDigestStats = { emailed: 0, overdue: 0, atRisk: 0 };
  await forEachActiveOrg(
    async (orgId) => {
      const s = await runAdrAlertDigestForOrg(orgId);
      stats.emailed += s.emailed;
      stats.overdue += s.overdue;
      stats.atRisk += s.atRisk;
    },
    { jobName: JOB },
  );
  return stats;
}

export async function registerAdrAlertDigestJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runAdrAlertDigest();
      logger.info(
        { event: "billing.adr-alert-digest.completed", ...stats },
        "billing.adr-alert-digest: completed",
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "billing.adr-alert-digest: failed",
      );
      throw err;
    }
  });
  if (CRON) {
    await boss.schedule(JOB, CRON);
    logger.info({ cron: CRON }, "billing.adr-alert-digest scheduled");
  } else {
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(JOB).catch(() => undefined);
    }
    logger.info("billing.adr-alert-digest registered (cron opt-in unset)");
  }
}
