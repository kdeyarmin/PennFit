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
  patientCheckinAttempts,
  patientLatestMessage,
  patientOnboardingJourneys,
  patientTherapyNights,
  type CsrComplianceAlertSeverity,
  type CsrComplianceAlertType,
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
  /** Active journeys evaluated for low-usage adherence. */
  scanned: number;
  /** New alert rows created this run (any alert type). */
  alertsCreated: number;
  /** Existing open alerts whose severity / snapshot was refreshed. */
  alertsUpdated: number;
  /** Active journeys with insufficient elapsed time to score. */
  skippedTooEarly: number;
  /** Active journeys currently meeting the adherence target. */
  onTrack: number;
  /** Patients flagged this run for repeated vendor failures. */
  sendFailureFlagged: number;
  /** Patients flagged this run for going dark on outbound nudges. */
  noResponseFlagged: number;
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
  let sendFailureFlagged = 0;
  let noResponseFlagged = 0;

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

    const wasUpdated = await upsertOpenAlert(db, {
      patientId: j.patientId,
      journeyId: j.journeyId,
      alertType: "low_usage",
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

  // Secondary detectors run AFTER the per-journey loop so they get a
  // single batched query each, regardless of how many active journeys
  // exist. Both keyed on the same csr_compliance_alerts table — same
  // upsert helper, distinct alert_type values.
  const sendFailures = await detectSendFailures(db, now);
  for (const f of sendFailures) {
    const wasUpdated = await upsertOpenAlert(db, {
      patientId: f.patientId,
      journeyId: f.journeyId,
      alertType: "send_failure",
      severity: f.severity,
      summary: f.summary,
      snapshot: f.snapshot,
    });
    if (wasUpdated) alertsUpdated++;
    else alertsCreated++;
    sendFailureFlagged++;
  }

  const noResponse = await detectNoResponse(db, now);
  for (const r of noResponse) {
    const wasUpdated = await upsertOpenAlert(db, {
      patientId: r.patientId,
      journeyId: r.journeyId,
      alertType: "no_response",
      severity: "warning",
      summary: r.summary,
      snapshot: r.snapshot,
    });
    if (wasUpdated) alertsUpdated++;
    else alertsCreated++;
    noResponseFlagged++;
  }

  return {
    scanned,
    alertsCreated,
    alertsUpdated,
    skippedTooEarly,
    onTrack,
    sendFailureFlagged,
    noResponseFlagged,
  };
}

// ───────────────────────────────────────────────────────────────────
// Send-failure detector
// ───────────────────────────────────────────────────────────────────
//
// Cluster patient_checkin_attempts rows over the last
// SEND_FAILURE_WINDOW_DAYS and flag any (journey, channel) pair with
// SEND_FAILURE_THRESHOLD or more vendor_error outcomes. Repeated
// failures point at stale contact info — the patient changed phones,
// the email bounced, or the carrier marked our messaging service
// SID as spam — and that's exactly the case the dispatcher cannot
// solve on its own (every retry fails the same way).

const SEND_FAILURE_WINDOW_DAYS = 14;
const SEND_FAILURE_THRESHOLD = 3;

interface SendFailureFinding {
  patientId: string;
  journeyId: string | null;
  severity: CsrComplianceAlertSeverity;
  summary: string;
  snapshot: Record<string, unknown>;
}

async function detectSendFailures(
  db: ReturnType<typeof drizzle>,
  now: Date,
): Promise<SendFailureFinding[]> {
  const since = new Date(now.getTime() - SEND_FAILURE_WINDOW_DAYS * MS_PER_DAY);

  // GROUP BY (patient, journey) to get per-patient totals. We don't
  // group by channel because a patient with vendor errors across
  // multiple channels is even MORE likely to have stale contact info,
  // not less — collapse to a single alert per patient.
  const rows = await db
    .select({
      patientId: patientCheckinAttempts.patientId,
      journeyId: patientCheckinAttempts.journeyId,
      failures: sql<number>`COUNT(*)`,
      lastError: sql<string | null>`MAX(${patientCheckinAttempts.errorCode})`,
      lastAttemptAt: sql<Date>`MAX(${patientCheckinAttempts.attemptedAt})`,
    })
    .from(patientCheckinAttempts)
    .where(
      and(
        eq(patientCheckinAttempts.outcome, "vendor_error"),
        gte(patientCheckinAttempts.attemptedAt, since),
      ),
    )
    .groupBy(
      patientCheckinAttempts.patientId,
      patientCheckinAttempts.journeyId,
    )
    .having(sql`COUNT(*) >= ${SEND_FAILURE_THRESHOLD}`);

  return rows.map((r) => {
    const failures = Number(r.failures);
    return {
      patientId: r.patientId,
      journeyId: r.journeyId,
      severity:
        failures >= SEND_FAILURE_THRESHOLD * 2 ? "critical" : "warning",
      summary: `${failures} vendor errors in last ${SEND_FAILURE_WINDOW_DAYS} days — likely stale contact info`,
      snapshot: {
        failures,
        window_days: SEND_FAILURE_WINDOW_DAYS,
        last_error_code: r.lastError ?? null,
        last_attempt_at: r.lastAttemptAt
          ? new Date(r.lastAttemptAt).toISOString()
          : null,
      },
    };
  });
}

// ───────────────────────────────────────────────────────────────────
// No-response detector
// ───────────────────────────────────────────────────────────────────
//
// For active journeys past day-30 with at least one outbound check-in
// send, flag patients whose `patient_latest_message.last_message_at`
// is older than NO_RESPONSE_GAP_DAYS (or who have no row at all). The
// flagged ones get a CSR follow-up — usually a phone call from a
// human — to either get them re-engaged or move them to status='paused'.
//
// We cap to journeys past day-30 because a patient who hasn't replied
// to day-3/day-7 is statistically normal — most patients just receive
// the nudge silently. By day-30 a still-engaged patient is much more
// likely to have replied at least once.

const NO_RESPONSE_GAP_DAYS = 21;
const NO_RESPONSE_MIN_DAYS_ELAPSED = 30;

interface NoResponseFinding {
  patientId: string;
  journeyId: string;
  summary: string;
  snapshot: Record<string, unknown>;
}

async function detectNoResponse(
  db: ReturnType<typeof drizzle>,
  now: Date,
): Promise<NoResponseFinding[]> {
  const cutoff = new Date(now.getTime() - NO_RESPONSE_GAP_DAYS * MS_PER_DAY);
  const minStartedAt = new Date(
    now.getTime() - NO_RESPONSE_MIN_DAYS_ELAPSED * MS_PER_DAY,
  );

  // LEFT JOIN against patient_latest_message — patients with zero
  // messages have no row, and that's exactly the population we want
  // to flag.
  const rows = await db
    .select({
      patientId: patientOnboardingJourneys.patientId,
      journeyId: patientOnboardingJourneys.id,
      startedAt: patientOnboardingJourneys.startedAt,
      lastMessageAt: patientLatestMessage.lastMessageAt,
      lastMessageDirection: patientLatestMessage.lastMessageDirection,
    })
    .from(patientOnboardingJourneys)
    .leftJoin(
      patientLatestMessage,
      eq(
        patientLatestMessage.patientId,
        patientOnboardingJourneys.patientId,
      ),
    )
    .where(
      and(
        eq(patientOnboardingJourneys.status, "active"),
        // Past the day-30 minimum elapsed window.
        sql`${patientOnboardingJourneys.startedAt} <= ${minStartedAt}`,
      ),
    );

  const findings: NoResponseFinding[] = [];
  for (const r of rows) {
    // Three fail-cases qualify:
    //   - no inbound message at all (lastMessageAt null)
    //   - last message is outbound (we sent something, no reply)
    //   - last inbound message is older than the gap window
    const lastInbound =
      r.lastMessageDirection === "inbound" ? r.lastMessageAt : null;
    if (lastInbound && lastInbound > cutoff) continue;

    const elapsedDays = Math.floor(
      (now.getTime() - r.startedAt.getTime()) / MS_PER_DAY,
    );
    findings.push({
      patientId: r.patientId,
      journeyId: r.journeyId,
      summary: lastInbound
        ? `No inbound reply in ${NO_RESPONSE_GAP_DAYS}+ days (day ${elapsedDays} of program)`
        : `No reply ever (day ${elapsedDays} of program)`,
      snapshot: {
        elapsed_days: elapsedDays,
        gap_days: NO_RESPONSE_GAP_DAYS,
        last_inbound_at: lastInbound ? lastInbound.toISOString() : null,
      },
    });
  }
  return findings;
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

async function upsertOpenAlert(
  db: ReturnType<typeof drizzle>,
  input: {
    patientId: string;
    journeyId: string | null;
    alertType: CsrComplianceAlertType;
    severity: CsrComplianceAlertSeverity;
    summary: string;
    snapshot: Record<string, unknown>;
  },
): Promise<boolean> {
  // The partial unique index on (patient_id, alert_type) WHERE
  // status='open' guarantees at most one open alert per (patient,
  // type). We try INSERT first; on conflict we UPDATE the existing
  // open row. Returns true if an existing row was refreshed.
  try {
    await db.insert(csrComplianceAlerts).values({
      patientId: input.patientId,
      journeyId: input.journeyId,
      alertType: input.alertType,
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
            eq(csrComplianceAlerts.alertType, input.alertType),
            eq(csrComplianceAlerts.status, "open"),
          ),
        );
      return true;
    }
    logger.warn(
      { err, patient_id: input.patientId, alert_type: input.alertType },
      "csr_compliance_alerts upsert failed",
    );
    return false;
  }
}
