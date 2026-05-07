// Compliance scanner — daily sweep that turns "patient is at risk
// of failing the 90-day adherence threshold" into a CSR alert row.
//
// CMS adherence threshold: ≥4 hours/night on ≥70% of nights in the
// first 90 days of therapy. Missing the threshold doesn't just lose
// the patient — it also blocks insurance from renewing supply
// eligibility, so the resupply revenue dries up too.
//
// Scoring logic per active onboarding journey:
//   1. Compute elapsed days since `started_at`. Cap at 90.
//   2. Pull patient_therapy_nights rows in [started_at, now].
//   3. Count nights with usage_minutes >= 240 (4 hours) → "good
//      nights". Compute good / elapsed as the adherence ratio.
//   4. Decide if the patient is at risk against a per-window target:
//        - days < 7  : no alert (too early to call it).
//        - 7  ≤ d < 30 : target 50%; below → warning alert.
//        - 30 ≤ d < 60 : target 60%; below → warning, <40% critical.
//        - 60 ≤ d < 90 : target 65%; below → warning, <45% critical.
//        - 90 ≤ d      : target 70%; below → critical.
//   5. Upsert csr_compliance_alerts row with alert_type='low_usage'
//      keyed by patient_id (the partial unique index makes this
//      "open-only", so a resolved alert for the same patient stays
//      put and a fresh row is created if the issue recurs).
//
// Why we don't fail-resolve old alerts here:
//   The scanner is conservative — it never auto-resolves. A patient
//   whose adherence rebounds will see the existing alert downgraded
//   in severity (or kept at 'warning'); a CSR who has reviewed the
//   alert is the one who marks it 'resolved' with a note. That puts
//   the human-in-the-loop at exactly the right place.

import { and, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  csrComplianceAlerts,
  getDbPool,
  patientOnboardingJourneys,
  patientTherapyNights,
  type CsrComplianceAlertSeverity,
} from "@workspace/resupply-db";

type DbPool = ReturnType<typeof getDbPool>;

import { logger } from "./logger";

export interface ScanOptions {
  pool: DbPool;
  /** Defaults to `new Date()`. Tests pass a fixed clock. */
  asOf?: Date;
  /** Per-run cap on alerts processed. Default 200 — well above the
   *  realistic active-journey count. */
  cap?: number;
}

export interface ScanSummary {
  scanned: number;
  /** New alert rows created this run. */
  alertsCreated: number;
  /** Existing open alerts whose severity / snapshot was refreshed. */
  alertsUpdated: number;
  /** Active journeys with insufficient elapsed time to score. */
  skippedTooEarly: number;
  /** Active journeys currently meeting the target. */
  onTrack: number;
}

interface JourneyScanRow {
  journeyId: string;
  patientId: string;
  startedAt: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_GOOD_NIGHT_MINUTES = 240; // 4 hours
const DEFAULT_CAP = 200;

export async function scanCompliance(opts: ScanOptions): Promise<ScanSummary> {
  const now = opts.asOf ?? new Date();
  const cap = opts.cap ?? DEFAULT_CAP;
  const db = drizzle(opts.pool);

  const journeys = (await db
    .select({
      journeyId: patientOnboardingJourneys.id,
      patientId: patientOnboardingJourneys.patientId,
      startedAt: patientOnboardingJourneys.startedAt,
    })
    .from(patientOnboardingJourneys)
    .where(eq(patientOnboardingJourneys.status, "active"))
    .limit(cap)) as JourneyScanRow[];

  let scanned = 0;
  let alertsCreated = 0;
  let alertsUpdated = 0;
  let skippedTooEarly = 0;
  let onTrack = 0;

  for (const j of journeys) {
    scanned++;
    const elapsedMs = now.getTime() - j.startedAt.getTime();
    const elapsedDays = Math.floor(elapsedMs / MS_PER_DAY);
    if (elapsedDays < 7) {
      skippedTooEarly++;
      continue;
    }

    // Pull good-night counts via aggregate to avoid streaming every
    // therapy night row across the wire. The unique index on
    // (patient_id, night_date, source) means we may have multiple
    // partner sources per night; we collapse to "any source had >=4h"
    // as a permissive interpretation (better to count a night good
    // than to miss credit).
    const nightAgg = await db
      .select({
        goodNights: sql<number>`COUNT(DISTINCT CASE WHEN ${patientTherapyNights.usageMinutes} >= ${MIN_GOOD_NIGHT_MINUTES} THEN ${patientTherapyNights.nightDate} END)`,
        totalNights: sql<number>`COUNT(DISTINCT ${patientTherapyNights.nightDate})`,
      })
      .from(patientTherapyNights)
      .where(
        and(
          eq(patientTherapyNights.patientId, j.patientId),
          gte(
            patientTherapyNights.nightDate,
            j.startedAt.toISOString().slice(0, 10),
          ),
        ),
      );
    const goodNights = Number(nightAgg[0]?.goodNights ?? 0);
    const totalNights = Number(nightAgg[0]?.totalNights ?? 0);
    // Adherence ratio uses elapsed-days (not totalNights) as the
    // denominator. Missing-data nights count against the patient,
    // matching how CMS scores adherence.
    const denom = Math.max(elapsedDays, 1);
    const adherence = goodNights / denom;

    const verdict = scoreAdherence(elapsedDays, adherence);
    if (verdict.level === "on_track") {
      onTrack++;
      continue;
    }

    const summary = renderSummary({
      elapsedDays,
      goodNights,
      totalNights,
      adherence,
      target: verdict.target,
    });
    const snapshot = {
      elapsed_days: elapsedDays,
      good_nights: goodNights,
      total_nights: totalNights,
      adherence_pct: Math.round(adherence * 100),
      target_pct: Math.round(verdict.target * 100),
    };

    const wasUpdated = await upsertLowUsageAlert(db, {
      patientId: j.patientId,
      journeyId: j.journeyId,
      severity: verdict.level === "critical" ? "critical" : "warning",
      summary,
      snapshot,
    });
    if (wasUpdated) {
      alertsUpdated++;
    } else {
      alertsCreated++;
    }
  }

  return { scanned, alertsCreated, alertsUpdated, skippedTooEarly, onTrack };
}

/**
 * Pure scoring function — exported for direct unit testing.
 */
export function scoreAdherence(
  elapsedDays: number,
  adherence: number,
): {
  level: "on_track" | "warning" | "critical";
  target: number;
} {
  if (elapsedDays < 7) return { level: "on_track", target: 0 };
  if (elapsedDays < 30) {
    const target = 0.5;
    return adherence >= target
      ? { level: "on_track", target }
      : { level: "warning", target };
  }
  if (elapsedDays < 60) {
    const target = 0.6;
    if (adherence >= target) return { level: "on_track", target };
    if (adherence < 0.4) return { level: "critical", target };
    return { level: "warning", target };
  }
  if (elapsedDays < 90) {
    const target = 0.65;
    if (adherence >= target) return { level: "on_track", target };
    if (adherence < 0.45) return { level: "critical", target };
    return { level: "warning", target };
  }
  // 90+ days: failing here is the irrecoverable case CMS uses to
  // deny adherence. Tag it critical regardless of the gap size.
  const target = 0.7;
  return adherence >= target
    ? { level: "on_track", target }
    : { level: "critical", target };
}

function renderSummary(args: {
  elapsedDays: number;
  goodNights: number;
  totalNights: number;
  adherence: number;
  target: number;
}): string {
  const pct = Math.round(args.adherence * 100);
  const targetPct = Math.round(args.target * 100);
  return `Day ${args.elapsedDays}: ${pct}% nights >=4hr (${args.goodNights}/${args.elapsedDays}, target ${targetPct}%)`;
}

async function upsertLowUsageAlert(
  db: ReturnType<typeof drizzle>,
  input: {
    patientId: string;
    journeyId: string;
    severity: CsrComplianceAlertSeverity;
    summary: string;
    snapshot: Record<string, unknown>;
  },
): Promise<boolean> {
  // The partial unique index on (patient_id, alert_type) WHERE
  // status='open' guarantees at most one open low_usage alert per
  // patient. We try INSERT first; on conflict we UPDATE the
  // severity/summary/snapshot/journey of the existing open row.
  try {
    await db.insert(csrComplianceAlerts).values({
      patientId: input.patientId,
      journeyId: input.journeyId,
      alertType: "low_usage",
      severity: input.severity,
      summary: input.summary,
      metricSnapshot: input.snapshot,
    });
    return false;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      // Race with the partial unique index — refresh the existing
      // open row instead.
      await db
        .update(csrComplianceAlerts)
        .set({
          severity: input.severity,
          summary: input.summary,
          metricSnapshot: input.snapshot,
          journeyId: input.journeyId,
        })
        .where(
          and(
            eq(csrComplianceAlerts.patientId, input.patientId),
            eq(csrComplianceAlerts.alertType, "low_usage"),
            eq(csrComplianceAlerts.status, "open"),
          ),
        );
      return true;
    }
    logger.warn(
      { err, patient_id: input.patientId },
      "csr_compliance_alerts upsert failed",
    );
    return false;
  }
}
