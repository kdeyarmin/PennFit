// pg-boss job: bill-hold sweep.
//
// Two jobs in one tick, both gated by the billing.bill_hold flag:
//
//   1. BACKFILL — seed the default required paperwork set onto draft claims
//      that have none tracked yet, so the hold genuinely covers ALL claims
//      (not just the ones a CSR happened to set up by hand). Idempotent:
//      seedDefaultRequirementsForClaim() skips any claim that already
//      carries a requirement, and auto-satisfies what's provably on file so
//      a fully-documented claim is never falsely frozen.
//
//   2. AUTO-REMIND — when billing.bill_hold_auto_remind is ALSO on, bump the
//      reminder bookkeeping on requirements that have gone stale, so the
//      worklist surfaces "chased N times / last nudged X days ago".
//
// SAFETY — OPT-IN CRON. The queue + worker always register, but the
// recurring schedule only attaches when BILL_HOLD_SWEEP_CRON is set, so a
// dev / preview / fresh prod never silently backfills holds onto every
// draft claim. Operators opt in once they're ready.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { seedDefaultRequirementsForClaim } from "../../lib/billing/bill-hold.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const BILL_HOLD_SWEEP_JOB = "billing.bill-hold-sweep";

/** How many draft claims to consider seeding per tick. Bounds the scan. */
const SEED_SCAN_CAP = 300;
/** Don't remind a requirement until it's at least this old. */
const REMIND_AFTER_DAYS = 3;
/** Wait this long between reminders on the same requirement. */
const REMIND_INTERVAL_DAYS = 3;
/** Cap reminders bumped per tick so one sweep can't fan out unbounded. */
const REMIND_CAP = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface BillHoldSweepStats {
  skipped: boolean;
  draftClaimsScanned: number;
  claimsSeeded: number;
  requirementsCreated: number;
  remindersBumped: number;
}

export async function runBillHoldSweep(
  supabase = getSupabaseServiceRoleClient(),
): Promise<BillHoldSweepStats> {
  const stats: BillHoldSweepStats = {
    skipped: false,
    draftClaimsScanned: 0,
    claimsSeeded: 0,
    requirementsCreated: 0,
    remindersBumped: 0,
  };

  if (!(await isFeatureEnabled("billing.bill_hold"))) {
    stats.skipped = true;
    return stats;
  }

  // ── 1. Backfill: seed defaults onto draft claims with no requirements ──
  const { data: drafts, error: draftErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id")
    .eq("status", "draft")
    .order("created_at", { ascending: true })
    .limit(SEED_SCAN_CAP);
  if (draftErr) throw draftErr;
  const draftIds = (drafts ?? []).map((c) => (c as { id: string }).id);
  stats.draftClaimsScanned = draftIds.length;

  if (draftIds.length > 0) {
    // Which of these already carry a requirement? One read, then seed the rest.
    const { data: withReqs, error: reqErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select("claim_id")
      .in("claim_id", draftIds);
    if (reqErr) throw reqErr;
    const haveReqs = new Set(
      (withReqs ?? [])
        .map((r) => (r as { claim_id: string | null }).claim_id)
        .filter((id): id is string => id != null),
    );
    for (const claimId of draftIds) {
      if (haveReqs.has(claimId)) continue;
      try {
        const result = await seedDefaultRequirementsForClaim(claimId, {
          supabase,
          createdByEmail: "system:bill-hold-sweep",
        });
        if (result.created > 0) {
          stats.claimsSeeded += 1;
          stats.requirementsCreated += result.created;
        }
      } catch (err) {
        logger.warn(
          { err, claimId },
          "bill-hold-sweep: seed failed for claim (continuing)",
        );
      }
    }
  }

  // ── 2. Auto-remind stale outstanding requirements ───────────────────
  if (await isFeatureEnabled("billing.bill_hold_auto_remind")) {
    const now = Date.now();
    const createdBefore = new Date(
      now - REMIND_AFTER_DAYS * MS_PER_DAY,
    ).toISOString();
    const remindBefore = new Date(
      now - REMIND_INTERVAL_DAYS * MS_PER_DAY,
    ).toISOString();
    const { data: stale, error: staleErr } = await supabase
      .schema("resupply")
      .from("claim_paperwork_requirements")
      .select("id, reminder_count, last_reminded_at")
      .eq("status", "outstanding")
      .eq("required", true)
      .lt("created_at", createdBefore)
      .order("created_at", { ascending: true })
      .limit(REMIND_CAP);
    if (staleErr) throw staleErr;
    const nowIso = new Date(now).toISOString();
    for (const row of stale ?? []) {
      const r = row as {
        id: string;
        reminder_count: number | null;
        last_reminded_at: string | null;
      };
      // Skip if reminded within the interval.
      if (r.last_reminded_at && r.last_reminded_at > remindBefore) continue;
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("claim_paperwork_requirements")
        .update({
          reminder_count: (r.reminder_count ?? 0) + 1,
          last_reminded_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", r.id);
      if (updErr) {
        logger.warn(
          { err: updErr.message, requirementId: r.id },
          "bill-hold-sweep: reminder bump update failed",
        );
      } else {
        stats.remindersBumped += 1;
      }
    }
  }

  return stats;
}

export async function registerBillHoldSweepJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, BILL_HOLD_SWEEP_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(BILL_HOLD_SWEEP_JOB, async () => {
    try {
      const stats = await runBillHoldSweep();
      logger.info(
        { event: "billing.bill-hold-sweep.completed", ...stats },
        "bill-hold-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "bill-hold-sweep: failed",
      );
      throw err;
    }
  });

  const cron = process.env.BILL_HOLD_SWEEP_CRON?.trim();
  if (cron) {
    await boss.schedule(BILL_HOLD_SWEEP_JOB, cron);
    logger.info({ cron }, "bill-hold-sweep scheduled");
  } else {
    // boss.schedule() persists the cron in pg-boss; merely not
    // re-scheduling does NOT stop a previously-attached schedule.
    // Clear any stale row so removing the env var actually turns
    // the cron off (same pattern as worker/lib/table-guard.ts).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(BILL_HOLD_SWEEP_JOB).catch(() => undefined);
    }
    logger.info(
      { queue: BILL_HOLD_SWEEP_JOB },
      "bill-hold-sweep registered (cron opt-in unset; manual-trigger only)",
    );
  }
}
