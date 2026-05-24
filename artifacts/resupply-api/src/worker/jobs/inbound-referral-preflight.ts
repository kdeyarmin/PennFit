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
import { buildQueueConfig, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

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

  // Atomically claim a batch of rows by setting updated_at to a marker value.
  // This prevents race conditions when multiple workers run simultaneously.
  const claimMarker = new Date().toISOString();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .update({ updated_at: claimMarker })
    .is("preflight_completed_at", null)
    .in("triage_status", ["new", "triaged"])
    .not("patient_match_id", "is", null)
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE)
    .select("id");
  if (error) {
    logger.error(
      { err: error.message },
      "inbound_referral.preflight.claim_failed",
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
  await boss.createQueue(JOB, buildQueueConfig(JOB, VENDOR_SEND_QUEUE_OPTS));
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
