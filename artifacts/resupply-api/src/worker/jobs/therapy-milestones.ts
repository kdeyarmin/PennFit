// pg-boss job: daily therapy-milestone evaluator + sender.
//
// Why this exists
// ---------------
// patient_therapy_nights is rich (nightly usage, AHI, leak, hours)
// but is only used by the smart-trigger engine for REORDER signals.
// Nothing watches it for ENGAGEMENT signals — and those signals are
// the ones with the highest open + click rates in DME adherence
// coaching:
//
//   1. The 100th-night anniversary.
//   2. The 365th-night anniversary.
//   3. The first rolling 30-night window where the patient crosses
//      the Medicare adherence target (>=70% of nights >=4hr).
//
// Patients who get celebrated stay on therapy longer. The cost is
// one table + one daily worker.
//
// Idempotency model
// -----------------
// resupply.patient_therapy_milestones has a UNIQUE (patient_id,
// milestone_kind). The worker does:
//
//   1. Evaluate: for each patient with night-data activity in the
//      last 60 days, compute the three milestones from
//      patient_therapy_nights and INSERT any that aren't already
//      recorded. The unique constraint backstops races.
//   2. Send:    for any milestone row where notified_at IS NULL,
//      send the celebration email and stamp notified_at.
//
// Crashing between evaluate and send is safe: the next run picks the
// row up from the partial index. Crashing after the SendGrid call
// but before the stamp would re-send on the next run — accepted
// trade because adherence celebrations are inherently rare events
// (one per patient per milestone-kind, ever) and a second copy is
// only mildly embarrassing, not damaging.
//
// Schedule
// --------
// 04:53 UTC daily — paired with the therapy nightly sync (04:30 UTC)
// so we evaluate against fresh nightly data. Far enough from
// rx-renewal-send (04:43) to avoid SendGrid rate-limit overlap.

import type PgBoss from "pg-boss";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { createQueueWithDlq, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";
import {
  sendTherapyMilestoneEmail,
  type MilestoneKind,
} from "../../lib/order-emails/send-therapy-milestone-email";

type MilestoneInsert =
  Database["resupply"]["Tables"]["patient_therapy_milestones"]["Insert"];

const JOB_NAME = "therapy-milestones.run";
const JOB_CRON = "53 4 * * *";

/** Medicare LCD adherence threshold (4 hours = 240 minutes). */
const ADHERENCE_THRESHOLD_MINUTES = 240;
/** Medicare LCD adherence threshold (70% of the rolling window). */
const ADHERENCE_PCT_THRESHOLD = 0.7;
/** Window length for the first-adherence-month milestone. */
const ADHERENCE_WINDOW_NIGHTS = 30;

/** Only consider patients whose therapy nights changed recently. */
const ACTIVITY_LOOKBACK_DAYS = 60;

export interface MilestoneStats {
  patientsScanned: number;
  inserted: Record<MilestoneKind, number>;
  sent: number;
  sendSkipped: number;
  sendFailed: number;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface NightRow {
  night_date: string;
  usage_minutes: number | null;
}

/**
 * Detect any milestones the patient has just hit but doesn't yet
 * have a row for. Pure function — easy to unit test against a
 * synthetic night array.
 */
export function detectMilestones(
  nights: NightRow[],
  existingKinds: Set<MilestoneKind>,
): Array<{
  kind: MilestoneKind;
  achievedOn: string;
  metricSnapshot: Record<string, unknown>;
}> {
  if (nights.length === 0) return [];

  // Date-sort ascending so cumulative checks are O(n).
  const sorted = [...nights].sort((a, b) =>
    a.night_date.localeCompare(b.night_date),
  );

  const out: Array<{
    kind: MilestoneKind;
    achievedOn: string;
    metricSnapshot: Record<string, unknown>;
  }> = [];

  // 1. 100 nights
  if (!existingKinds.has("100_nights") && sorted.length >= 100) {
    out.push({
      kind: "100_nights",
      achievedOn: sorted[99]!.night_date,
      metricSnapshot: { totalNights: 100 },
    });
  }

  // 2. 365 nights
  if (!existingKinds.has("365_nights") && sorted.length >= 365) {
    out.push({
      kind: "365_nights",
      achievedOn: sorted[364]!.night_date,
      metricSnapshot: { totalNights: 365 },
    });
  }

  // 3. First 30-night rolling window with >= 70% adherence
  if (
    !existingKinds.has("first_adherence_month") &&
    sorted.length >= ADHERENCE_WINDOW_NIGHTS
  ) {
    // Pre-mark each night as compliant or not, then slide the window.
    // We only count nights where usage_minutes is recorded — nights
    // missing data are excluded from both numerator and denominator.
    for (let end = ADHERENCE_WINDOW_NIGHTS - 1; end < sorted.length; end++) {
      const window = sorted.slice(end - ADHERENCE_WINDOW_NIGHTS + 1, end + 1);
      let recorded = 0;
      let compliant = 0;
      for (const n of window) {
        if (n.usage_minutes == null) continue;
        recorded += 1;
        if (n.usage_minutes >= ADHERENCE_THRESHOLD_MINUTES) compliant += 1;
      }
      // Need at least 20 recorded nights in the window so a single
      // sleepy week of data can't false-positive a milestone.
      if (recorded < 20) continue;
      const pct = compliant / recorded;
      if (pct >= ADHERENCE_PCT_THRESHOLD) {
        out.push({
          kind: "first_adherence_month",
          achievedOn: window[window.length - 1]!.night_date,
          metricSnapshot: {
            adherencePct: Math.round(pct * 100),
            recordedNights: recorded,
            compliantNights: compliant,
          },
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Run the daily milestone scan + send. Exported for testability.
 */
export async function runTherapyMilestones(): Promise<MilestoneStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: MilestoneStats = {
    patientsScanned: 0,
    inserted: { "100_nights": 0, "365_nights": 0, "first_adherence_month": 0 },
    sent: 0,
    sendSkipped: 0,
    sendFailed: 0,
  };

  // ── EVALUATE ────────────────────────────────────────────────────
  // Find patients with night-data activity in the last N days. Anyone
  // who didn't sync in 60 days couldn't have produced a new
  // milestone, so we save the scan cost. (Existing milestone rows
  // for old patients are still picked up in the SEND step below.)
  //
  // We use a raw SQL query via RPC or a separate aggregation to get
  // distinct patient_id values server-side rather than fetching rows
  // and deduplicating client-side. Since PostgREST doesn't have a
  // direct .distinct() on select, we work around by grouping in a
  // subquery. For now, we keep the client-side dedup but note that
  // a better approach would be to use a PostgreSQL function or view.
  const activitySince = isoDaysAgo(ACTIVITY_LOOKBACK_DAYS);
  const { data: activePatients, error: actErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("patient_id")
    .gte("updated_at", `${activitySince}T00:00:00.000Z`);
  if (actErr) throw actErr;

  const uniquePatientIds = Array.from(
    new Set((activePatients ?? []).map((r) => r.patient_id)),
  );
  stats.patientsScanned = uniquePatientIds.length;

  for (const patientId of uniquePatientIds) {
    // Pull the patient's full night history (sorted ascending).
    // We cap at 400 to keep the row read bounded — anything past
    // 400 nights has already triggered 100 + 365 + adherence, so
    // there's no further milestone to detect.
    const { data: nights, error: nightsErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date, usage_minutes")
      .eq("patient_id", patientId)
      .order("night_date", { ascending: true })
      .limit(400);
    if (nightsErr) {
      logger.warn(
        { err: nightsErr.message, patientId },
        "therapy-milestones: night read failed",
      );
      continue;
    }
    const { data: existing } = await supabase
      .schema("resupply")
      .from("patient_therapy_milestones")
      .select("milestone_kind")
      .eq("patient_id", patientId);
    const existingKinds = new Set(
      (existing ?? []).map((r) => r.milestone_kind as MilestoneKind),
    );
    const detected = detectMilestones(nights ?? [], existingKinds);

    for (const m of detected) {
      const insertRow: MilestoneInsert = {
        patient_id: patientId,
        milestone_kind: m.kind,
        achieved_on: m.achievedOn,
        // Json is a recursive type; the snapshot is plain key/number
        // and round-trips losslessly. Cast keeps the row literal
        // typed without dragging Json through detectMilestones.
        metric_snapshot: m.metricSnapshot as Json,
      };
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_milestones")
        .insert(insertRow);
      if (insErr) {
        // Likely a race — partner cron tick or unique-violation. Either way
        // not actionable here; the existing row will get sent below.
        logger.info(
          {
            patientId,
            kind: m.kind,
            err: insErr.message,
          },
          "therapy-milestones: insert skipped (likely already exists)",
        );
        continue;
      }
      stats.inserted[m.kind] += 1;
    }
  }

  // ── SEND ────────────────────────────────────────────────────────
  // Send any milestone rows still waiting for notification, across
  // all patients (not just those active in the last 60 days — a
  // newly-inserted milestone on an inactive patient still deserves
  // the celebration).
  const { data: pending, error: pendErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_milestones")
    .select("id, patient_id, milestone_kind, metric_snapshot")
    .is("notified_at", null)
    .limit(500);
  if (pendErr) throw pendErr;

  for (const row of pending ?? []) {
    // Claim the row first (atomic stamp). Wins iff still null.
    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_milestones")
      .update({
        notified_at: claimIso,
        notification_channel: "email",
      })
      .eq("id", row.id)
      .is("notified_at", null)
      .select("id, patient_id, milestone_kind, metric_snapshot")
      .limit(1)
      .maybeSingle();
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, milestoneId: row.id },
        "therapy-milestones: claim failed",
      );
      stats.sendFailed += 1;
      continue;
    }
    if (!claimed) {
      // Lost the race to a parallel run.
      stats.sendSkipped += 1;
      continue;
    }

    const releaseClaim = async (): Promise<void> => {
      await supabase
        .schema("resupply")
        .from("patient_therapy_milestones")
        .update({ notified_at: null, notification_channel: null })
        .eq("id", claimed.id);
    };

    // Resolve recipient email + first name.
    const { data: patient, error: patientError } = await supabase
      .schema("resupply")
      .from("patients")
      .select("email, legal_first_name")
      .eq("id", claimed.patient_id)
      .limit(1)
      .maybeSingle();
    if (patientError) {
      await releaseClaim();
      stats.sendFailed += 1;
      logger.error(
        {
          err: patientError.message,
          milestoneId: claimed.id,
          patientId: claimed.patient_id,
        },
        "therapy-milestones: patient lookup failed",
      );
      continue;
    }
    if (!patient || !patient.email) {
      // No deliverable — leave the stamp so we don't retry every day.
      stats.sendSkipped += 1;
      continue;
    }

    const metrics =
      (claimed.metric_snapshot as Record<string, unknown> | null) ?? {};
    const totalNights = typeof metrics.totalNights === "number"
      ? metrics.totalNights
      : undefined;
    const adherencePct = typeof metrics.adherencePct === "number"
      ? metrics.adherencePct
      : undefined;

    try {
      const result = await sendTherapyMilestoneEmail({
        toEmail: patient.email,
        firstName: patient.legal_first_name,
        kind: claimed.milestone_kind as MilestoneKind,
        metrics: { totalNights, adherencePct },
      });
      if (!result.configured) {
        await releaseClaim();
        stats.sendSkipped += 1;
        continue;
      }
      if (!result.delivered) {
        await releaseClaim();
        stats.sendFailed += 1;
        logger.warn(
          {
            milestoneId: claimed.id,
            kind: claimed.milestone_kind,
            error: result.error,
          },
          "therapy-milestones: send failed (claim released)",
        );
        continue;
      }
      stats.sent += 1;

      // Best-effort push fan-out — same news, separate channel.
      // Runs AFTER the email so a push misconfig (or a customer
      // with no shop_customers row, hence no push subscriptions)
      // never rolls back the email delivery state. Logged at INFO
      // for ops visibility on push activation; counts only.
      try {
        const { sendPushToCustomerByEmail } = await import("../../lib/web-push");
        const title =
          claimed.milestone_kind === "100_nights"
            ? "100 nights on therapy — congrats!"
            : claimed.milestone_kind === "365_nights"
              ? "One year of CPAP therapy"
              : "Adherence target reached";
        await sendPushToCustomerByEmail(patient.email, {
          title,
          body: "Tap to see your therapy summary.",
          url: "/account#therapy",
          tag: `therapy_milestone:${claimed.id}`,
        });
      } catch (pushErr) {
        logger.info(
          {
            milestoneId: claimed.id,
            err: pushErr instanceof Error ? pushErr.message : String(pushErr),
          },
          "therapy-milestones: push fanout skipped (non-fatal)",
        );
      }
    } catch (err) {
      await releaseClaim();
      stats.sendFailed += 1;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          milestoneId: claimed.id,
        },
        "therapy-milestones: send threw (claim released)",
      );
    }
  }

  return stats;
}

export async function registerTherapyMilestonesJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, JOB_NAME, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runTherapyMilestones();
      logger.info(
        { event: "therapy-milestones.completed", ...stats },
        "therapy-milestones: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "therapy-milestones: failed",
      );
      throw err;
    }
  });

  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "therapy-milestones scheduled");
}
