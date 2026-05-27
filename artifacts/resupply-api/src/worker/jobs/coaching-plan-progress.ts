// pg-boss job: nightly refresh of `latest_compliance_pct` on open
// coaching plans, plus optional auto-flip into the `improving` /
// `resolved` lanes when adherence crosses thresholds.
//
// Why this exists
// ---------------
// Without the worker, the latest_compliance_pct column only updates
// when a CSR PATCHes the plan. That makes the plan list lag — a
// patient could be hitting their target for two weeks and the plan
// still shows the day-1 snapshot.
//
// What this job does
// ------------------
//   1. Pulls open coaching plans (closed_at IS NULL).
//   2. For each, computes the patient's adherence rate over the
//      last 30 nights from patient_therapy_nights (≥4 hours per
//      night = compliant per Medicare).
//   3. Updates latest_compliance_pct on the plan.
//   4. Auto-transitions:
//      * If rate >= target AND status == "outreach_made" → "improving"
//      * If rate >= target AND has been "improving" for 14+ days
//        (target_date check OR latest_outreach_at + 14d) → leaves
//        it alone (CSR closes manually with a resolution note).
//
// Conservative posture: we don't auto-resolve. Resolution requires
// a CSR-authored note for the audit trail. Auto-improvement is the
// only state move the worker takes.

import type PgBoss from "pg-boss";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type CoachingPlanUpdate =
  Database["resupply"]["Tables"]["patient_coaching_plans"]["Update"];

import { logger } from "../../lib/logger";
import { createQueueWithDlq, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

const PROGRESS_JOB = "coaching-plan.progress-sweep";
const PROGRESS_CRON = "41 4 * * *";
const WINDOW_DAYS = 30;
const COMPLIANT_HOURS_PER_NIGHT = 4;

export interface ProgressSweepStats {
  scanned: number;
  updated: number;
  movedToImproving: number;
}

export async function runCoachingProgressSweep(): Promise<ProgressSweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: ProgressSweepStats = {
    scanned: 0,
    updated: 0,
    movedToImproving: 0,
  };

  const { data: plans, error } = await supabase
    .schema("resupply")
    .from("patient_coaching_plans")
    .select(
      "id, patient_id, status, target_compliance_pct, latest_compliance_pct, latest_outreach_at, updated_at",
    )
    .is("closed_at", null)
    .limit(500);
  if (error) throw error;
  const planList = plans ?? [];
  if (planList.length === 0) return stats;

  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);
  const windowStartIso = windowStart.toISOString().slice(0, 10);

  for (const plan of planList) {
    stats.scanned += 1;
    const { data: nights, error: nightsErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("usage_minutes, night_date, source")
      // Order by usage_minutes desc so the dedup loop below keeps
      // the highest-minute source per night. A night with a manual
      // entry (e.g. partial recall) plus a device upload should
      // count the device upload — taking the first arbitrary
      // PostgREST row would depress compliance pct.
      .order("usage_minutes", { ascending: false, nullsFirst: false })
      .eq("patient_id", plan.patient_id)
      .gte("night_date", windowStartIso)
      .limit(WINDOW_DAYS * 4); // 4 sources max per night
    if (nightsErr) {
      logger.warn(
        { err: nightsErr, planId: plan.id },
        "coaching-plan.progress: nights fetch failed",
      );
      continue;
    }

    // Dedup by night_date — keep the first row for each date. With
    // the ORDER BY usage_minutes desc above, "first" = highest.
    const seen = new Set<string>();
    let compliantNights = 0;
    let totalNights = 0;
    for (const row of nights ?? []) {
      if (seen.has(row.night_date)) continue;
      seen.add(row.night_date);
      totalNights += 1;
      const minutes = row.usage_minutes ?? 0;
      if (minutes >= COMPLIANT_HOURS_PER_NIGHT * 60) compliantNights += 1;
    }

    if (totalNights === 0) continue;
    const pct = Math.round((compliantNights / totalNights) * 100);
    const priorPct =
      plan.latest_compliance_pct != null
        ? Number(plan.latest_compliance_pct)
        : null;
    if (priorPct !== null && Math.round(priorPct) === pct) {
      continue;
    }

    const update: CoachingPlanUpdate = {
      latest_compliance_pct: pct.toString(),
    };
    // Auto-flip outreach_made → improving only when the
    // outreach is fresh enough that the compliance bump is
    // plausibly caused by it. A CSR who manually walked the
    // plan BACK to outreach_made (e.g. patient regressed
    // after a temporary spike) shouldn't be immediately
    // re-flipped to improving by this sweep — that erases
    // the CSR's intent. 14 days mirrors the WINDOW_DAYS used
    // for the compliance rollup at the top of this file.
    const FLIP_FRESHNESS_DAYS = 14;
    const recencyAnchor = plan.latest_outreach_at ?? plan.updated_at;
    const recencyMs = recencyAnchor ? Date.parse(recencyAnchor) : NaN;
    const flipIsRecent =
      Number.isFinite(recencyMs) &&
      Date.now() - recencyMs <= FLIP_FRESHNESS_DAYS * 24 * 3600 * 1000;
    if (
      pct >= plan.target_compliance_pct &&
      plan.status === "outreach_made" &&
      flipIsRecent
    ) {
      update.status = "improving";
      stats.movedToImproving += 1;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .update(update)
      .eq("id", plan.id);
    if (updErr) {
      logger.warn(
        { err: updErr, planId: plan.id },
        "coaching-plan.progress: update failed",
      );
      continue;
    }
    stats.updated += 1;
  }

  return stats;
}

export async function registerCoachingProgressJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, PROGRESS_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(PROGRESS_JOB, async () => {
    try {
      const stats = await runCoachingProgressSweep();
      logger.info(
        { event: "coaching-plan.progress-sweep.completed", ...stats },
        "coaching-plan.progress-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "coaching-plan.progress-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(PROGRESS_JOB, PROGRESS_CRON);
  logger.info(
    { cron: PROGRESS_CRON },
    "coaching-plan.progress-sweep scheduled",
  );
}
