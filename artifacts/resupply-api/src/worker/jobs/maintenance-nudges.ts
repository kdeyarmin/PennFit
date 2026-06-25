// pg-boss job: weekly hygiene nudge email.
//
// Patient hygiene without a nudge is a passive checklist; this job
// surfaces "your cushion wash is 3 days overdue" via email so the
// reminder reaches patients who don't browse /account regularly.
//
// Scheduling: weekly, Sunday morning 11:13 UTC. The catalog's
// fastest cadence is daily (mask cushion wipe), so a weekly nudge
// occasionally catches a 6-day-overdue wipe — close enough for
// patient engagement without spam.
//
// Bundling: one email per patient listing every currently-overdue
// task (typically 0–3). Patients who completed everything in the
// last week get nothing.
//
// Quiet period: 7 days. The patient_maintenance_nudges audit row
// stamps each send; the eligibility scan skips any patient whose
// most recent nudge is younger than 7 days.

import type PgBoss from "pg-boss";

import {
  DEFAULT_SENDGRID_FROM_EMAIL,
  EmailConfigError,
} from "@workspace/resupply-email";
import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  MAINTENANCE_CATALOG,
  bucketizeMaintenance,
  type MaintenanceTask,
} from "../../lib/patient-maintenance/catalog";
import { logger } from "../../lib/logger";
import { createTenantSendgridClient } from "../../lib/email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding.js";
import { recordOutboundMessageUsage } from "../../lib/metering/usage.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const NUDGE_JOB = "patient-maintenance.weekly-nudge";
const NUDGE_CRON = "13 11 * * 0";
const QUIET_PERIOD_MS = 7 * 86_400_000;
// Bound how many patients we EMAIL per nudge run. Bigger DMEs can
// raise this — the cron picks up the rest next week. Cap kept low
// during initial rollout to avoid SendGrid burst limits.
const BATCH_SIZE = 200;
// Keyset-scan page size and the per-run scan ceiling. Skipped rows
// (not-yet-engaged patients — the MAJORITY of any roster — and
// nothing-overdue patients) are never stamped, so a single
// `order id asc, limit BATCH_SIZE` slate stalled permanently once the
// skip cohort at the front of the id order exceeded the slate: every
// patient behind them was never evaluated again (the documented
// lapsed-customer-winback starvation class). Paging keeps walking past
// skips until the send cap or the scan ceiling is hit.
const SCAN_PAGE = BATCH_SIZE * 2;
const MAX_SCANNED_PER_RUN = BATCH_SIZE * 25;

interface NudgeStats {
  scanned: number;
  emailed: number;
  skippedQuiet: number;
  skippedNoOverdue: number;
  skippedNoContact: number;
  errors: number;
}

interface MessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
  sendgridFromName: string | null;
  practiceName: string;
  publicBaseUrl: string;
}

export function readNudgeMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail:
      env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "CareMetric Breathe",
    publicBaseUrl:
      (env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
        (env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
          : "")) ||
      "",
  };
}

/** Compose the email body for a patient with a set of overdue tasks. */
export function composeNudgeEmail(opts: {
  practiceName: string;
  publicBaseUrl: string;
  overdueTasks: Array<{ task: MaintenanceTask; daysOverdue: number }>;
}): { subject: string; html: string; text: string } {
  const tasks = opts.overdueTasks.slice(0, 6);
  const subject =
    tasks.length === 1
      ? `Time to ${tasks[0]!.task.label.toLowerCase()}`
      : `${tasks.length} hygiene tasks waiting for you`;
  const accountUrl = `${opts.publicBaseUrl}/account`;
  const lines: string[] = [
    `Quick reminder from ${opts.practiceName} — a few hygiene tasks are due:`,
    "",
    ...tasks.map((t) => {
      const ageNote =
        t.daysOverdue > 0
          ? ` (${t.daysOverdue} day${t.daysOverdue === 1 ? "" : "s"} overdue)`
          : "";
      return `• ${t.task.label}${ageNote} — ${t.task.why}`;
    }),
    "",
    `Check them off on your account page:`,
    accountUrl,
    "",
    "Skipping a week is fine. We won't pile up reminders.",
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>Quick reminder from <strong>${escapeHtml(opts.practiceName)}</strong> — a few hygiene tasks are due:</p>
    <ul>${tasks
      .map(
        (t) =>
          `<li><strong>${escapeHtml(t.task.label)}</strong>${
            t.daysOverdue > 0
              ? ` <span style="color:#a16207;">(${t.daysOverdue} day${t.daysOverdue === 1 ? "" : "s"} overdue)</span>`
              : ""
          } — ${escapeHtml(t.task.why)}</li>`,
      )
      .join("")}</ul>
    <p>Check them off on your account page:<br>
       <a href="${accountUrl}">${escapeHtml(accountUrl)}</a></p>
    <p style="color:#666;font-size:13px;">Skipping a week is fine. We won't pile up reminders.</p>
  </div>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emptyNudgeStats(): NudgeStats {
  return {
    scanned: 0,
    emailed: 0,
    skippedQuiet: 0,
    skippedNoOverdue: 0,
    skippedNoContact: 0,
    errors: 0,
  };
}

/**
 * Run the weekly hygiene nudge for a SINGLE tenant, returning this tenant's
 * tally. Extracted so the cron can fan out across every active tenant —
 * `patients` and `patient_maintenance_*` are tenant-scoped, so each tenant
 * must be swept on its own org-scoped client (a patient is only ever
 * nudged for tasks/contacts in their own org). The as-of clock is built
 * once per run and threaded in; the SendGrid client + brand are now
 * resolved PER tenant so each tenant sends under its own From identity and
 * brand name (G6). The per-tenant send cap (BATCH_SIZE) and scan ceiling
 * apply PER tenant.
 */
async function maintenanceNudgeSweepForOrg(
  orgId: string,
  cfg: MessagingConfig,
  asOfDate: Date,
): Promise<NudgeStats> {
  const stats = emptyNudgeStats();

  // Send under the tenant's own From identity (G6); the seed tenant resolves
  // to the platform default, so single-tenant behavior is unchanged. A
  // tenant whose sender config is incomplete is skipped gracefully rather
  // than failing the whole fan-out.
  let sendgrid: Awaited<ReturnType<typeof createTenantSendgridClient>>;
  try {
    sendgrid = await createTenantSendgridClient(orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) return stats;
    throw err;
  }
  // Brand the copy with the tenant's own storefront name (G6); for the seed
  // tenant this resolves to "PennPaps" so single-tenant copy is unchanged.
  const brand = await resolveBrandingByOrgId(orgId);
  // Build the account link from the tenant's own storefront origin (its
  // verified custom domain) when it has one; the seed tenant falls through to
  // the env-derived platform base, so single-tenant is unchanged. Resolved once
  // per tenant sweep.
  const tenantBaseUrl =
    (await resolveTenantBaseUrl(orgId)) ?? cfg.publicBaseUrl;
  const supabase = getOrgScopedClient(orgId);

  // Eligible patients: anyone with an email AND at least one
  // therapy_link or therapy_night (i.e. an active CPAP user). We
  // don't want to badger pre-onboarding leads or returning
  // customers with no therapy stream.
  // Pre-filter at the DB layer: exclude patients whose most recent
  // nudge is within the quiet period. Without this, BATCH_SIZE could
  // be entirely consumed by low-id patients still in their cooldown
  // window, starving the cohort past id N from EVER being evaluated.
  // We fetch the still-warm list first (small — only one row per
  // patient nudged in the last QUIET_PERIOD_MS) and exclude those
  // ids from the candidate query. The remaining JS-side quiet check
  // below stays as a defense-in-depth read-after-write guard.
  const cutoffPre = new Date(Date.now() - QUIET_PERIOD_MS).toISOString();
  const { data: recentNudges, error: nudgeListErr } = await supabase
    .from("patient_maintenance_nudges")
    .select("patient_id")
    .gte("sent_at", cutoffPre);
  if (nudgeListErr) throw nudgeListErr;
  const recentlyNudgedIds = new Set<string>();
  for (const r of recentNudges ?? []) {
    if (r.patient_id) recentlyNudgedIds.add(r.patient_id);
  }

  // Build the query in one chain so TypeScript's deep PostgREST type
  // inference doesn't blow out with TS2589 on the conditional .not()
  // path. When we have a cap-busting number of recently-nudged
  // patients we accept some starvation risk over an unbounded URL.
  // PostgREST's NOT IN serializes the values as `(a,b,c)`.
  const excludeFilter =
    recentlyNudgedIds.size > 0 && recentlyNudgedIds.size <= 5000
      ? `(${Array.from(recentlyNudgedIds).join(",")})`
      : null;

  // Keyset-paged candidate walk — see the SCAN_PAGE comment up top for
  // why a single LIMIT slate starved everything behind the skip cohort.
  let lastPatientId = "00000000-0000-0000-0000-000000000000";
  let scannedTotal = 0;
  pages: while (
    stats.emailed < BATCH_SIZE &&
    scannedTotal < MAX_SCANNED_PER_RUN
  ) {
    // Single-chain build (the TS2589 note above): the cursor predicate
    // is UNCONDITIONAL — the nil UUID sorts below every real id, so the
    // first page's `gt` excludes nothing — leaving only the original,
    // proven excludeFilter ternary.
    const baseQuery = supabase
      .from("patients")
      .select("id, email")
      .not("email", "is", null)
      // Only ACTIVE patients get hygiene-maintenance email. Every other
      // patient-send path gates on status === 'active' (reminders
      // send-sms/send-email, escalation planning); this job was the outlier
      // and would email paused / discharged / deceased patients who happened
      // to have engaged with a maintenance task in the past. Filter in-DB so
      // inactive rows don't consume the scan budget either.
      .eq("status", "active")
      .gt("id", lastPatientId);
    const filteredQuery = excludeFilter
      ? baseQuery.not("id", "in", excludeFilter)
      : baseQuery;
    const { data: candidates, error } = await filteredQuery
      .order("id", { ascending: true })
      .limit(SCAN_PAGE);
    if (error) throw error;
    if (!candidates || candidates.length === 0) break;
    scannedTotal += candidates.length;
    lastPatientId = candidates[candidates.length - 1]!.id;
    const patients = (
      candidates as Array<{ id: string; email: string | null }>
    ).filter((p): p is { id: string; email: string } => p.email != null);
    if (patients.length === 0) continue;

    // Batch the per-task last-completion read for THIS page. The prior
    // loop issued one full `patient_maintenance_log` read per patient
    // (N+1); a naive `.in()` would instead pull every log row for every
    // patient (years of history) and risk truncation. The
    // patient_maintenance_latest_by_task RPC (mig 0232) returns one row
    // per (patient, task) — at most patients × the small fixed task
    // catalog — so we fetch in chunks of 100 patient_ids and index by
    // patient. Patients already filtered by the in-memory quiet guard
    // are excluded so we don't fetch logs we'll skip.
    const eligibleForLog = patients
      .map((p) => p.id)
      .filter((id) => !recentlyNudgedIds.has(id));
    const logByPatient = new Map<string, Map<string, string>>();
    for (let i = 0; i < eligibleForLog.length; i += 100) {
      const idChunk = eligibleForLog.slice(i, i + 100);
      // RPCs aren't tenant-scoped by the facade; the p_patient_ids are
      // already org-filtered (from the scoped patients query above), so
      // the result is implicitly org-correct. Reach the RPC via raw().
      const { data: logRows, error: logBatchErr } = await supabase
        .raw()
        .schema("resupply")
        .rpc("patient_maintenance_latest_by_task", { p_patient_ids: idChunk });
      if (logBatchErr) throw logBatchErr;
      for (const r of (logRows ?? []) as Array<{
        patient_id: string;
        task_key: string;
        completed_at: string;
      }>) {
        if (!r.patient_id || !r.task_key) continue;
        let m = logByPatient.get(r.patient_id);
        if (!m) {
          m = new Map<string, string>();
          logByPatient.set(r.patient_id, m);
        }
        // The RPC already returns the latest row per (patient, task); keep
        // the first seen as a defensive guard against any duplicate.
        if (!m.has(r.task_key)) m.set(r.task_key, r.completed_at);
      }
    }

    for (const patient of patients) {
      if (stats.emailed >= BATCH_SIZE) break pages;
      stats.scanned += 1;

      // Quiet-period guard, now in-memory. `recentlyNudgedIds` was built
      // above from the SAME quiet-period cutoff, so the prior per-patient
      // `patient_maintenance_nudges` read just re-derived a fact we already
      // hold — a textbook N+1. In the normal path these ids were already
      // excluded from the candidate query, so this rarely fires; it still
      // matters in the >5000-recently-nudged escape case, where the
      // candidate query skips the NOT-IN exclusion (unbounded-URL guard)
      // and this Set is the only remaining quiet guard.
      if (recentlyNudgedIds.has(patient.id)) {
        stats.skippedQuiet += 1;
        continue;
      }

      // Per-task last-completion, from the pre-fetched batch.
      const latest = logByPatient.get(patient.id) ?? new Map<string, string>();

      // Build the overdue list. We only nudge for tasks the patient
      // has STARTED — pure-new patients see the checklist on /account
      // but don't get an email until they've engaged with at least
      // one task. Avoids "welcome to CareMetric Breathe, here are 5 chores." A
      // patient with no completion rows is absent from the batch (empty
      // map) → treated as not-yet-engaged, exactly as before.
      const hasEngaged = latest.size > 0;
      if (!hasEngaged) {
        stats.skippedNoOverdue += 1;
        continue;
      }

      const overdueTasks: Array<{
        task: MaintenanceTask;
        daysOverdue: number;
      }> = [];
      for (const task of MAINTENANCE_CATALOG) {
        const lastCompletedAt = latest.get(task.key) ?? null;
        const info = bucketizeMaintenance({
          lastCompletedAt,
          frequencyDays: task.frequencyDays,
          asOfDate,
        });
        if (info.bucket === "due_now") {
          overdueTasks.push({
            task,
            daysOverdue: Math.max(0, -info.daysUntilDue),
          });
        }
      }

      if (overdueTasks.length === 0) {
        stats.skippedNoOverdue += 1;
        continue;
      }

      // Send.
      const { subject, html, text } = composeNudgeEmail({
        practiceName: brand.storefrontName,
        publicBaseUrl: tenantBaseUrl,
        overdueTasks,
      });
      try {
        await sendgrid.sendEmail({
          to: patient.email,
          subject,
          html,
          text,
        });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : "unknown",
            patientId: patient.id,
          },
          "patient-maintenance.weekly-nudge: send failed",
        );
        stats.errors += 1;
        continue;
      }
      recordOutboundMessageUsage({
        orgId,
        channel: "email",
        source: "maintenance_nudge.email",
      });

      // Log the nudge.
      const { error: insErr } = await supabase
        .from("patient_maintenance_nudges")
        .insert({
          patient_id: patient.id,
          channel: "email",
          task_keys: overdueTasks.map((t) => t.task.key),
        });
      if (insErr) {
        // Won't double-send within this run (the loop is per-patient);
        // next week's quiet-period check might let through a duplicate
        // if the log write failed but the email landed. Acceptable.
        logger.warn(
          { err: insErr, patientId: patient.id },
          "patient-maintenance.weekly-nudge: log insert failed",
        );
      }
      stats.emailed += 1;
    }
  }

  return stats;
}

/**
 * Run the weekly hygiene nudge for EVERY active tenant. Builds the SendGrid
 * client + as-of clock once, then fans out across active tenants with
 * per-tenant failure isolation (forEachActiveOrg), aggregating each
 * tenant's tally. A patient is only ever nudged on their own org's
 * client, so one tenant's roster can never reach another tenant's patients.
 * Exported for tests.
 */
export async function runMaintenanceNudgeSweep(
  cfg: MessagingConfig = readNudgeMessagingConfig(),
): Promise<NudgeStats> {
  const stats = emptyNudgeStats();
  if (!cfg.sendgridApiKey || !cfg.sendgridFromName || !cfg.publicBaseUrl) {
    logger.warn(
      { event: "patient-maintenance.weekly-nudge.skipped_no_config" },
      "maintenance-nudge: skipping run, messaging config incomplete",
    );
    return stats;
  }

  // The SendGrid client is now built PER tenant inside the sweep (G6) so each
  // tenant sends under its own From identity; the config-gate above stays as a
  // cheap platform-level pre-check.
  const asOfDate = new Date();

  await forEachActiveOrg(
    async (orgId) => {
      const orgStats = await maintenanceNudgeSweepForOrg(orgId, cfg, asOfDate);
      stats.scanned += orgStats.scanned;
      stats.emailed += orgStats.emailed;
      stats.skippedQuiet += orgStats.skippedQuiet;
      stats.skippedNoOverdue += orgStats.skippedNoOverdue;
      stats.skippedNoContact += orgStats.skippedNoContact;
      stats.errors += orgStats.errors;
    },
    { jobName: NUDGE_JOB },
  );

  return stats;
}

export async function registerMaintenanceNudgeJob(boss: PgBoss): Promise<void> {
  // This job is a BULK sweep (many patients per run), not a single vendor
  // send, so two overlap-safety overrides on top of the vendor preset:
  //   * policy "singleton" — pg-boss runs at most one sweep at a time, so a
  //     manual re-trigger (or a retry firing near the next cron tick) can't
  //     run concurrently with an in-flight sweep and double-send.
  //   * retryLimit 1 — the vendor preset's 5 retries would re-sweep the
  //     whole roster up to 5×; a per-patient send error is already caught
  //     inline (it never throws the sweep), so the only thing that retries
  //     is a roster-level (e.g. DB) failure, where one retry is plenty and
  //     more just risks re-sending to the tail processed before the failure.
  // The 15-minute expiry of the vendor preset is kept (a large roster can
  // take longer than the cron-scan preset's 5-minute window).
  await createQueueWithDlq(boss, NUDGE_JOB, VENDOR_SEND_QUEUE_OPTS, {
    policy: "singleton",
    retryLimit: 1,
  });
  await boss.work(NUDGE_JOB, async () => {
    try {
      const stats = await runMaintenanceNudgeSweep();
      logger.info(
        { event: "patient-maintenance.weekly-nudge.completed", ...stats },
        "patient-maintenance.weekly-nudge: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patient-maintenance.weekly-nudge: failed",
      );
      throw err;
    }
  });
  await boss.schedule(NUDGE_JOB, NUDGE_CRON);
  logger.info(
    { cron: NUDGE_CRON },
    "patient-maintenance.weekly-nudge scheduled",
  );
}
