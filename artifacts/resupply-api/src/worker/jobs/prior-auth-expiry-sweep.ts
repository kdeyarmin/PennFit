// pg-boss job: daily prior-authorization expiry sweep.
//
// Why this exists
// ---------------
// The /patients/:id/prior-authorizations route's comment header
// states that "approved → expired is set by a daily sweep, not by
// the API". Without that sweep, every PA stays at status='approved'
// past its approved_through date, so:
//
//   * the smart-trigger evaluator and resupply cadence rules keep
//     greenlighting fulfillments against PAs that are no longer
//     valid, and
//   * the CSR queue has no surface for "this PA is about to lapse —
//     start the renewal now" until a claim denial trickles back
//     from the payer days or weeks later.
//
// What this job does
// ------------------
// Once a day at 03:47 UTC (off-peak, sequenced between the
// idempotency-key prune at 02:07 and the smart-trigger evaluator at
// 03:23):
//
//   1. EXPIRE step
//      UPDATE prior_authorizations
//      SET status = 'expired'
//      WHERE status = 'approved' AND approved_through < today.
//      Each expiry emits a csr_compliance_alerts row of type
//      'prior_auth_expired' (severity 'critical') and an audit row
//      so the lifecycle is reconstructible offline.
//
//   2. PRE-EXPIRY HEADS-UP step
//      For PAs that ARE still 'approved' but whose approved_through
//      falls in the next 7 / 14 / 30 days, queue an alert of type
//      'prior_auth_expiring'. Idempotent on (patient_id, alert_type,
//      metric_snapshot.priorAuthId, metric_snapshot.window) — a
//      re-run on the same day produces zero net new alerts.
//
// Why CSR alerts instead of patient-facing nudges
// -----------------------------------------------
// Patients don't drive PA renewals — the prescribing physician's
// office does, and the billing team coordinates between them. The
// alert surface is the CSR queue, not the patient inbox. A future
// surface could fan out a patient email when the renewal stalls,
// but that belongs in a separate job with its own opt-in posture.
//
// Audit
// -----
// Every state transition is audited with adminEmail=
// "system:cron:prior-auth-expiry-sweep" so a query can distinguish
// cron-driven expirations from a (hypothetical) future admin
// "mark-expired" action. Heads-up alerts are NOT audited per row
// (would explode the log for a 5K-PA portfolio); the daily summary
// log line carries the counts.

import type PgBoss from "pg-boss";

import { logAuditBestEffort } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const SWEEP_JOB = "prior-auth.expiry-sweep";
const SWEEP_CRON = "47 3 * * *";
const SYSTEM_ACTOR_EMAIL = "system:cron:prior-auth-expiry-sweep";

/** Heads-up windows, in days before approved_through. */
const HEADS_UP_WINDOWS = [30, 14, 7] as const;

export interface ExpirySweepStats {
  expired: number;
  headsUpQueued: number;
  windows: Record<(typeof HEADS_UP_WINDOWS)[number], number>;
}

/**
 * Convert a Date to a UTC `YYYY-MM-DD` date string.
 *
 * @param d - The input Date to convert
 * @returns The UTC date in `YYYY-MM-DD` format
 */
function isoDate(d: Date): string {
  // YYYY-MM-DD in UTC. approved_through is a `date` column with no
  // timezone, so we compare day-by-day in UTC and accept that a PA
  // expiring at 23:59 local east of UTC may show as expired up to a
  // day early. That's fine for renewal triage.
  return d.toISOString().slice(0, 10);
}

/**
 * Returns a new Date representing `base` shifted by `days` days using UTC date arithmetic.
 *
 * @param base - The starting date
 * @param days - Number of days to add (may be negative to subtract days)
 * @returns A new `Date` advanced from `base` by `days` days using UTC-based date math
 */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Sweep prior authorizations: transition overdue `approved` records to `expired` and queue pre-expiry heads-up alerts.
 *
 * @param today - Reference date used to determine expirations; comparisons are performed at the day (YYYY-MM-DD) level in UTC.
 * @returns The populated `ExpirySweepStats` containing counts of expired records, total heads-up alerts queued, and per-window counts for 30, 14, and 7 day windows.
 * @throws If the initial query for overdue prior authorizations fails.
 */
export async function runPriorAuthExpirySweep(
  today: Date = new Date(),
): Promise<ExpirySweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const todayIso = isoDate(today);

  const stats: ExpirySweepStats = {
    expired: 0,
    headsUpQueued: 0,
    windows: { 30: 0, 14: 0, 7: 0 },
  };

  // ── 1. EXPIRE step ──────────────────────────────────────────────
  //
  // We do this in two passes so the audit-row write happens with
  // the previous status visible. Reading first, then updating, also
  // gives us patient_id + hcpcs_code for the CSR alert.
  const { data: dueToExpire, error: dueErr } = await supabase
    .schema("resupply")
    .from("prior_authorizations")
    .select(
      "id, patient_id, hcpcs_code, payer_name, approved_through, auth_number",
    )
    .eq("status", "approved")
    .lt("approved_through", todayIso);
  if (dueErr) throw dueErr;

  for (const row of dueToExpire ?? []) {
    const { data: updatedRows, error: updErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .update({ status: "expired" })
      .eq("id", row.id)
      .eq("status", "approved")
      .select("id");
    if (updErr) {
      logger.warn(
        { err: updErr.message, paId: row.id },
        "prior-auth.expiry-sweep: expire update failed",
      );
      continue;
    }
    if (!updatedRows || updatedRows.length === 0) {
      logger.info(
        { paId: row.id },
        "prior-auth.expiry-sweep: update returned no rows (likely race)",
      );
      continue;
    }
    stats.expired += 1;

    // CSR alert — critical: patient may need a dispense block until
    // the renewal lands.
    await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: row.patient_id,
        alert_type: "prior_auth_expired",
        severity: "critical",
        summary: `PA expired: ${row.hcpcs_code} (${row.payer_name})`,
        metric_snapshot: {
          priorAuthId: row.id,
          hcpcsCode: row.hcpcs_code,
          payerName: row.payer_name,
          approvedThrough: row.approved_through,
          authNumber: row.auth_number,
        },
      });

    await logAuditBestEffort(
      {
        action: "prior_authorization.expired",
        adminEmail: SYSTEM_ACTOR_EMAIL,
        adminUserId: null,
        targetTable: "prior_authorizations",
        targetId: row.id,
        metadata: {
          hcpcsCode: row.hcpcs_code,
          payerName: row.payer_name,
          approvedThrough: row.approved_through,
        },
        ip: null,
        userAgent: null,
      },
      {
        contextLabel: "prior_auth_expiry_sweep",
        onWriteFailure: (failure) => {
          logger.warn(failure, "prior-auth.expiry-sweep: audit write failed");
        },
      },
    );
  }

  // ── 2. PRE-EXPIRY HEADS-UP step ────────────────────────────────
  //
  // For each window, find PAs still 'approved' whose
  // approved_through lands ON that date. We use exact-day-match
  // (not <=) so each PA produces at most one alert per window,
  // even if the cron is re-run later in the day.
  for (const win of HEADS_UP_WINDOWS) {
    const target = isoDate(addDays(today, win));
    const { data: upcoming, error: upErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select(
        "id, patient_id, hcpcs_code, payer_name, approved_through, auth_number",
      )
      .eq("status", "approved")
      .eq("approved_through", target);
    if (upErr) {
      logger.warn(
        { err: upErr.message, window: win },
        "prior-auth.expiry-sweep: heads-up read failed",
      );
      continue;
    }

    for (const row of upcoming ?? []) {
      // Idempotency: check if an alert with this priorAuthId + window
      // already exists in 'open' state. metric_snapshot is jsonb so we
      // use ->> to compare a specific field.
      const { data: existing } = await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .select("id")
        .eq("patient_id", row.patient_id)
        .eq("alert_type", "prior_auth_expiring")
        .eq("status", "open")
        .filter("metric_snapshot->>priorAuthId", "eq", row.id)
        .filter("metric_snapshot->>window", "eq", String(win))
        .limit(1);
      if (existing && existing.length > 0) continue;

      // Severity escalates the closer we are to expiry.
      const severity: "warning" | "critical" = win <= 7 ? "critical" : "warning";

      await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .insert({
          patient_id: row.patient_id,
          alert_type: "prior_auth_expiring",
          severity,
          summary: `PA expires in ${win} days: ${row.hcpcs_code} (${row.payer_name})`,
          metric_snapshot: {
            priorAuthId: row.id,
            hcpcsCode: row.hcpcs_code,
            payerName: row.payer_name,
            approvedThrough: row.approved_through,
            authNumber: row.auth_number,
            window: win,
          },
        });
      stats.headsUpQueued += 1;
      stats.windows[win] += 1;
    }
  }

  return stats;
}

/**
 * Register and schedule the daily "prior-auth.expiry-sweep" job on a PgBoss instance.
 *
 * Sets up the queue and worker that execute the expiry sweep (runPriorAuthExpirySweep), logs completion or failure, and schedules the job using the configured cron.
 *
 * @param boss - The PgBoss client used to create the queue, register the worker, and schedule the cron job
 */
export async function registerPriorAuthExpirySweepJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(SWEEP_JOB);

  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runPriorAuthExpirySweep();
      logger.info(
        { event: "prior-auth.expiry-sweep.completed", ...stats },
        "prior-auth.expiry-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "prior-auth.expiry-sweep: failed",
      );
      throw err;
    }
  });

  await boss.schedule(SWEEP_JOB, SWEEP_CRON);
  logger.info({ cron: SWEEP_CRON }, "prior-auth.expiry-sweep scheduled");
}
