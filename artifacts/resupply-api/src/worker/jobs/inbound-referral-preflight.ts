// pg-boss job: run pre-flight on inbound referrals that haven't had
// one yet.
//
// Cadence
// -------
// Every 5 minutes. Phase 1+2 lands the referral with a patient/provider
// match; Phase 3 fills in "does this payer need PA, is eligibility
// active, what docs are missing?" as a background pass so the CSR's
// triage detail page renders the answers inline.
//
// What the job does
// -----------------
// SELECT inbound_referral_orders
//   WHERE preflight_completed_at IS NULL
//     AND triage_status IN ('new', 'triaged')
//     AND patient_match_id IS NOT NULL
//   ORDER BY received_at ASC
//   LIMIT BATCH_SIZE
//
// For each row, call runReferralPreflight(). The library writes the
// per-check rows + stamps preflight_completed_at; this worker is
// just the scheduler.
//
// We require patient_match_id because every meaningful check
// (eligibility, docs gap, physician fax) depends on a matched
// patient. Referrals without a match stay in the queue for human
// triage.
//
// Re-entrancy: idempotent on `preflight_completed_at IS NULL`. A
// re-run after stamp = no-op. Manual re-runs go through the
// /admin/inbound-referrals/:id/run-preflight route (which clears
// the stamp and re-runs via the same library).
//
// PHI posture: per-row logs carry the referral id + check kinds +
// outcome status only. No payer name, no patient FK in the log.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runReferralPreflight } from "../../lib/inbound-dispatchers/preflight";
import { logger } from "../../lib/logger";
import { createQueueWithDlq, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

const JOB = "inbound-referral.preflight";
const CRON = "*/5 * * * *"; // every 5 minutes
const BATCH_SIZE = 20;
const SYSTEM_ACTOR = "system:cron:preflight";

export interface PreflightTickStats {
  scanned: number;
  completed: number;
  failed: number;
}

export async function runInboundReferralPreflightTick(): Promise<PreflightTickStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: PreflightTickStats = {
    scanned: 0,
    completed: 0,
    failed: 0,
  };

  // Select a batch of referrals still needing preflight. We intentionally
  // do NOT take a DB-level claim: pg-boss runs this scheduled job as a
  // singleton (ticks don't overlap), and runReferralPreflight is
  // idempotent — it clears prior checks before re-recording and the
  // physician-fax side effect is cool-down-guarded — so a re-run (manual
  // /run-preflight route, a retry, or a future overlap) converges to one
  // correct result instead of duplicating rows. The previous
  // `UPDATE ... SET updated_at` looked like a claim but changed no
  // WHERE-predicate column, so it never actually excluded a concurrent
  // tick's rows — it only churned updated_at. Dropped.
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .select("id")
    .is("preflight_completed_at", null)
    .in("triage_status", ["new", "triaged"])
    .not("patient_match_id", "is", null)
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    logger.error(
      { err: error.message },
      "inbound_referral.preflight.select_failed",
    );
    throw error;
  }
  if (!rows || rows.length === 0) return stats;
  stats.scanned = rows.length;

  for (const row of rows) {
    try {
      await runReferralPreflight({
        referralId: row.id,
        ranBy: SYSTEM_ACTOR,
      });
      stats.completed += 1;
    } catch (err) {
      stats.failed += 1;
      logger.warn(
        {
          referral_id: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "inbound_referral.preflight.row_failed",
      );
      // Continue with the rest of the batch — one bad row shouldn't
      // strand the queue.
    }
  }
  return stats;
}

export async function registerInboundReferralPreflightJob(
  boss: PgBoss,
): Promise<void> {
  if (process.env.RESUPPLY_INBOUND_REFERRALS_ENABLED !== "1") {
    // Inbound referral / EHR integration is not provisioned here — the
    // inbound_referral_* tables only exist once that integration is set up
    // (see docs/db-schema-drift-2026-05-29.md). Unschedule any cron a prior
    // deploy left behind so it stops firing into missing tables, then skip
    // worker registration. Set RESUPPLY_INBOUND_REFERRALS_ENABLED=1 once the
    // schema + a partner tenant exist.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(JOB).catch(() => undefined);
    }
    logger.info(
      { event: "inbound_referral_jobs_disabled", job: JOB },
      `${JOB}: not registered (RESUPPLY_INBOUND_REFERRALS_ENABLED!=1); cleared any stale cron`,
    );
    return;
  }
  await createQueueWithDlq(boss, JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runInboundReferralPreflightTick();
      if (stats.scanned > 0) {
        logger.info(
          { event: "inbound_referral.preflight.completed", ...stats },
          "inbound_referral.preflight: tick",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "inbound_referral.preflight: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "inbound_referral.preflight scheduled");
}
