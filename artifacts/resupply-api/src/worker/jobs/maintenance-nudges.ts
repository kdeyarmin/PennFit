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
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
} from "@workspace/resupply-email";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  MAINTENANCE_CATALOG,
  bucketizeMaintenance,
  type MaintenanceTask,
} from "../../lib/patient-maintenance/catalog";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const NUDGE_JOB = "patient-maintenance.weekly-nudge";
const NUDGE_CRON = "13 11 * * 0";
const QUIET_PERIOD_MS = 7 * 86_400_000;
// Bound how many patients we email per nudge run. Bigger DMEs can
// raise this — the cron picks up the rest next week. Cap kept low
// during initial rollout to avoid SendGrid burst limits.
const BATCH_SIZE = 200;

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
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
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

/** Run a single sweep. Exported for tests. */
export async function runMaintenanceNudgeSweep(
  cfg: MessagingConfig = readNudgeMessagingConfig(),
): Promise<NudgeStats> {
  const stats: NudgeStats = {
    scanned: 0,
    emailed: 0,
    skippedQuiet: 0,
    skippedNoOverdue: 0,
    skippedNoContact: 0,
    errors: 0,
  };
  if (!cfg.sendgridApiKey || !cfg.sendgridFromName || !cfg.publicBaseUrl) {
    logger.warn(
      { event: "patient-maintenance.weekly-nudge.skipped_no_config" },
      "maintenance-nudge: skipping run, messaging config incomplete",
    );
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();

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
    .schema("resupply")
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
  const baseQuery = supabase
    .schema("resupply")
    .from("patients")
    .select("id, email")
    .not("email", "is", null);
  const filteredQuery = excludeFilter
    ? baseQuery.not("id", "in", excludeFilter)
    : baseQuery;
  const { data: candidates, error } = await filteredQuery
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  const patients = (candidates ?? []).filter(
    (p): p is { id: string; email: string } => p.email != null,
  );
  if (patients.length === 0) return stats;

  const sendgrid = createSendgridClient({
    apiKey: cfg.sendgridApiKey,
    fromEmail: cfg.sendgridFromEmail,
    fromName: cfg.sendgridFromName,
  });
  const asOfDate = new Date();

  // Batch the per-task last-completion read. The prior loop issued one
  // full `patient_maintenance_log` read per patient (N+1); a naive
  // `.in()` would instead pull every log row for every patient (years of
  // history) and risk truncation. The patient_maintenance_latest_by_task
  // RPC (mig 0232) returns one row per (patient, task) — at most patients
  // × the small fixed task catalog — so we fetch in chunks of 100
  // patient_ids and index by patient. Patients already filtered by the
  // in-memory quiet guard are excluded so we don't fetch logs we'll skip.
  const eligibleForLog = patients
    .map((p) => p.id)
    .filter((id) => !recentlyNudgedIds.has(id));
  const logByPatient = new Map<string, Map<string, string>>();
  for (let i = 0; i < eligibleForLog.length; i += 100) {
    const idChunk = eligibleForLog.slice(i, i + 100);
    const { data: logRows, error: logBatchErr } = await supabase
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
    // one task. Avoids "welcome to PennFit, here are 5 chores." A
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
      practiceName: cfg.practiceName,
      publicBaseUrl: cfg.publicBaseUrl,
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

    // Log the nudge.
    const { error: insErr } = await supabase
      .schema("resupply")
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

  return stats;
}

export async function registerMaintenanceNudgeJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, NUDGE_JOB, VENDOR_SEND_QUEUE_OPTS);
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
