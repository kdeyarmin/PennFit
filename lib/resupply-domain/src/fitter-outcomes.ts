// Fitter outcome KPIs — pure value-object logic (ADR 008: no I/O).
//
// Why this module exists
// ----------------------
// Every number here is already being written; nothing reads it as a rate.
// `mask_fit_outcomes` (0201/0203) feeds the recommendation engine's
// per-mask tuning multiplier and `fit_sessions` (0483) drives the RT
// review queue, but neither surfaces "how often does a fitting we made
// come back as a bad fit" — which is the single number competitors in
// this space sell on. The data layer flattens both tables and hands the
// rows here.
//
// Honesty rules (same posture as the LTV/CAC and margin modules)
// --------------------------------------------------------------
//   * A rate over an empty denominator is NULL, never 0. "No fittings
//     reported a bad fit" and "nobody has reported anything yet" are
//     different facts and must not render identically.
//   * A per-mask rate needs a minimum sample before it is reported at
//     all. One patient reporting a leak on a mask dispensed once is not
//     a 100% refit rate. The floor mirrors `computeFitAdjustments`,
//     which already refuses to tune a mask below 10 outcomes.
//   * Recommendation acceptance counts only sessions where a decision is
//     actually recorded. A fitting nobody has acted on yet is UNDECIDED,
//     not accepted — counting it either way would move the headline
//     number with the passage of time rather than with clinical reality.
//
// Deliberately NOT sourced here: the client-side scan-failure reason
// codes (`no_face`, `iris_too_small`, …) emitted by the fitter SPA. They
// land in `public.usage_events`, which is an anonymous funnel table with
// NO `org_id` — reading it into a tenant-scoped report would show one DME
// another DME's scan failures. Scan health is reported instead from
// `fit_sessions.scan_quality_grade`, which is org-scoped and describes
// the scans that actually produced a fitting.

/** Confidence outcome the engine settled on for a fitting. */
export type FitSessionOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

export type FitEntryPoint = "remote_link" | "in_office" | "kiosk_qr";

export type ScanQualityGrade = "good" | "marginal" | "poor";

/** Patient's own verdict after wearing it. */
export type MaskFitVerdict = "good" | "leaking" | "uncomfortable";

export interface FitSessionInput {
  id: string;
  createdAt: string;
  entryPoint: FitEntryPoint;
  outcome: FitSessionOutcome | null;
  scanQualityGrade: ScanQualityGrade | null;
  degraded: boolean;
  /** What the engine put first. */
  primaryMaskModelId: string | null;
  /** What a clinician chose instead, when they overrode. */
  overrideMaskModelId: string | null;
  overrideReason: string | null;
  /** What was actually ordered, once that is known. */
  orderedMaskModelId: string | null;
  reviewedAt: string | null;
  dispensedAt: string | null;
}

export interface MaskFitOutcomeInput {
  /** Catalog id or SKU the outcome was reported against; null when the
   *  survey response could not be attributed to a mask. */
  maskId: string | null;
  /** Display name, when the data layer could resolve one. */
  maskLabel?: string | null;
  verdict: MaskFitVerdict;
}

export interface FitterOutcomesOptions {
  /**
   * Minimum reported outcomes before a mask gets its own refit rate.
   * Matches `computeFitAdjustments`'s tuning floor — below this a rate is
   * noise, and publishing it invites a decision it cannot support.
   */
  minOutcomesPerMask?: number;
  /** How many override reasons to return. */
  topOverrideReasons?: number;
}

export interface MaskRefitRate {
  maskId: string;
  maskLabel: string | null;
  outcomes: number;
  good: number;
  leaking: number;
  uncomfortable: number;
  /** (leaking + uncomfortable) / outcomes. */
  refitRate: number;
}

export interface FitterOutcomesReport {
  sessions: {
    total: number;
    byEntryPoint: Record<FitEntryPoint, number>;
    byOutcome: Record<FitSessionOutcome, number>;
    /** Sessions with no outcome recorded (still in progress, or degraded
     *  before the engine reached one). */
    outcomeUnknown: number;
    byScanQuality: Record<ScanQualityGrade, number>;
    scanQualityUnknown: number;
    /** Ran with a degraded input (missing catalog, formulary, etc.). */
    degraded: number;
    /** Share of sessions the engine was confident enough to stand behind
     *  without review. Null when there are no sessions at all. */
    highConfidenceRate: number | null;
  };
  acceptance: {
    /** Sessions where what-was-chosen is actually known. */
    decided: number;
    accepted: number;
    overridden: number;
    /** accepted / decided. Null when nothing has been decided yet. */
    acceptanceRate: number | null;
    /** Sessions with a recommendation but no decision recorded yet. */
    undecided: number;
    topOverrideReasons: Array<{ reason: string; count: number }>;
  };
  refit: {
    /** Survey responses received (the denominator). */
    responses: number;
    good: number;
    leaking: number;
    uncomfortable: number;
    /** (leaking + uncomfortable) / responses. Null with no responses. */
    refitRate: number | null;
    /** Worst-first, and only masks at or above `minOutcomesPerMask`. */
    byMask: MaskRefitRate[];
    /** Responses excluded from `byMask` because their mask is below the
     *  sample floor or unattributed. Reported so a thin byMask list reads
     *  as thin data rather than as a clean bill of health. */
    belowSampleFloor: number;
    unattributed: number;
  };
  dispensing: {
    dispensed: number;
    /** dispensed / total sessions. Null when there are no sessions. */
    dispenseRate: number | null;
    /** Median hours from fitting to clinical review, over reviewed
     *  sessions only. Null when nothing has been reviewed. */
    medianHoursToReview: number | null;
  };
}

const ENTRY_POINTS: FitEntryPoint[] = ["remote_link", "in_office", "kiosk_qr"];
const OUTCOMES: FitSessionOutcome[] = [
  "high_confidence",
  "moderate_confidence",
  "low_confidence",
  "contraindicated",
  "outside_validated_range",
];
const SCAN_GRADES: ScanQualityGrade[] = ["good", "marginal", "poor"];

/** A rate, or null when the denominator is empty. Never 0-by-default. */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Which way a fitting actually went.
 *
 * `undecided` is a first-class answer: a fitting with a recommendation
 * that nobody has ordered or overridden yet tells us nothing about
 * whether clinicians agree with the engine, and folding it into either
 * bucket would make the acceptance rate drift as a queue ages rather than
 * as clinical opinion changes.
 */
function classifyDecision(
  s: FitSessionInput,
): "accepted" | "overridden" | "undecided" {
  if (!s.primaryMaskModelId) return "undecided";
  if (s.overrideMaskModelId) {
    // A clinician who "overrides" back onto the recommended mask has
    // agreed with it, whatever the button was called.
    return s.overrideMaskModelId === s.primaryMaskModelId
      ? "accepted"
      : "overridden";
  }
  if (s.orderedMaskModelId) {
    return s.orderedMaskModelId === s.primaryMaskModelId
      ? "accepted"
      : "overridden";
  }
  return "undecided";
}

/**
 * Roll fittings and post-delivery fit surveys into the outcome report.
 *
 * Pure: the caller supplies both row sets already filtered to a tenant and
 * a period.
 */
export function buildFitterOutcomesReport(
  sessions: FitSessionInput[],
  outcomes: MaskFitOutcomeInput[],
  options: FitterOutcomesOptions = {},
): FitterOutcomesReport {
  const minOutcomesPerMask = Math.max(1, options.minOutcomesPerMask ?? 10);
  const topOverrideReasons = Math.max(0, options.topOverrideReasons ?? 5);

  const byEntryPoint = Object.fromEntries(
    ENTRY_POINTS.map((k) => [k, 0]),
  ) as Record<FitEntryPoint, number>;
  const byOutcome = Object.fromEntries(
    OUTCOMES.map((k) => [k, 0]),
  ) as Record<FitSessionOutcome, number>;
  const byScanQuality = Object.fromEntries(
    SCAN_GRADES.map((k) => [k, 0]),
  ) as Record<ScanQualityGrade, number>;

  let outcomeUnknown = 0;
  let scanQualityUnknown = 0;
  let degraded = 0;
  let accepted = 0;
  let overridden = 0;
  let undecided = 0;
  let dispensed = 0;
  const reviewLatencyHours: number[] = [];
  const overrideReasonCounts = new Map<string, number>();

  for (const s of sessions) {
    if (ENTRY_POINTS.includes(s.entryPoint)) byEntryPoint[s.entryPoint] += 1;
    if (s.outcome && OUTCOMES.includes(s.outcome)) byOutcome[s.outcome] += 1;
    else outcomeUnknown += 1;
    if (s.scanQualityGrade && SCAN_GRADES.includes(s.scanQualityGrade)) {
      byScanQuality[s.scanQualityGrade] += 1;
    } else {
      scanQualityUnknown += 1;
    }
    if (s.degraded) degraded += 1;
    if (s.dispensedAt) dispensed += 1;

    switch (classifyDecision(s)) {
      case "accepted":
        accepted += 1;
        break;
      case "overridden": {
        overridden += 1;
        const reason = (s.overrideReason ?? "").trim();
        // An override with no stated reason is the most actionable thing
        // on this list — it means the queue is losing the "why".
        const key = reason.length > 0 ? reason : "(no reason given)";
        overrideReasonCounts.set(key, (overrideReasonCounts.get(key) ?? 0) + 1);
        break;
      }
      default:
        undecided += 1;
    }

    if (s.reviewedAt) {
      const started = Date.parse(s.createdAt);
      const reviewed = Date.parse(s.reviewedAt);
      if (Number.isFinite(started) && Number.isFinite(reviewed)) {
        const hours = (reviewed - started) / 3_600_000;
        // A negative latency means clock skew or a backfilled row, not a
        // review that happened before the fitting. Drop rather than let
        // it drag the median below zero.
        if (hours >= 0) reviewLatencyHours.push(hours);
      }
    }
  }

  // ── Post-delivery fit surveys ──────────────────────────────────────
  let good = 0;
  let leaking = 0;
  let uncomfortable = 0;
  let unattributed = 0;
  const perMask = new Map<
    string,
    { label: string | null; good: number; leaking: number; uncomfortable: number }
  >();

  for (const o of outcomes) {
    if (o.verdict === "good") good += 1;
    else if (o.verdict === "leaking") leaking += 1;
    else uncomfortable += 1;

    const maskId = o.maskId?.trim();
    if (!maskId) {
      unattributed += 1;
      continue;
    }
    const entry = perMask.get(maskId) ?? {
      label: o.maskLabel ?? null,
      good: 0,
      leaking: 0,
      uncomfortable: 0,
    };
    entry[o.verdict] += 1;
    if (!entry.label && o.maskLabel) entry.label = o.maskLabel;
    perMask.set(maskId, entry);
  }

  const responses = outcomes.length;
  const byMask: MaskRefitRate[] = [];
  let belowSampleFloor = 0;
  for (const [maskId, e] of perMask) {
    const total = e.good + e.leaking + e.uncomfortable;
    if (total < minOutcomesPerMask) {
      belowSampleFloor += total;
      continue;
    }
    byMask.push({
      maskId,
      maskLabel: e.label,
      outcomes: total,
      good: e.good,
      leaking: e.leaking,
      uncomfortable: e.uncomfortable,
      refitRate: (e.leaking + e.uncomfortable) / total,
    });
  }
  // Worst first — this list exists to be acted on. Ties broken by sample
  // size so the better-evidenced problem sorts higher.
  byMask.sort((a, b) => b.refitRate - a.refitRate || b.outcomes - a.outcomes);

  const overrideReasons = [...overrideReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, topOverrideReasons);

  const decided = accepted + overridden;

  return {
    sessions: {
      total: sessions.length,
      byEntryPoint,
      byOutcome,
      outcomeUnknown,
      byScanQuality,
      scanQualityUnknown,
      degraded,
      highConfidenceRate: rate(byOutcome.high_confidence, sessions.length),
    },
    acceptance: {
      decided,
      accepted,
      overridden,
      acceptanceRate: rate(accepted, decided),
      undecided,
      topOverrideReasons: overrideReasons,
    },
    refit: {
      responses,
      good,
      leaking,
      uncomfortable,
      refitRate: rate(leaking + uncomfortable, responses),
      byMask,
      belowSampleFloor,
      unattributed,
    },
    dispensing: {
      dispensed,
      dispenseRate: rate(dispensed, sessions.length),
      medianHoursToReview: median(reviewLatencyHours),
    },
  };
}
