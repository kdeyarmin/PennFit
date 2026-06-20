// Eligibility re-verification ranking — pure staleness classifier
// (ADR 008: no I/O, defaults to "now" only when no `asOf` is supplied).
//
// What this is
// ------------
// A payer's confirmation that a patient is covered goes stale: a coverage
// verified months ago, or one whose termination date is bearing down, must
// be re-checked before the next claim goes out or the supplier bills into a
// lapse. This is the shared classifier that turns a list of active
// coverages into a re-verification worklist, banded by urgency:
//
//   * never_verified   — no `verifiedAt` on file yet
//   * terminating_soon — termination date within the lookahead window
//   * stale            — last verified more than `staleDays` ago
//   * ok               — recently verified, no imminent termination
//
// Urgency ordering: terminating_soon outranks never_verified (a coverage
// about to lapse is time-boxed); both beat stale; ok sinks to the bottom.
// Within a band the tie-break is the SHARPER signal — soonest termination
// first for terminating_soon, longest-stale first otherwise.
//
// Why it lives in @workspace/resupply-domain
// -------------------------------------------
// Both the worklist route (read half) and the batch runner (write half)
// rank coverages the exact same way. Keeping the rule in the pure domain
// layer removes the route↔lib import cycle AND lets the SPA preview the
// same banding. No DB row type — `CoverageInput` is a plain projection of
// only the fields the rule reads.

export type VerificationStatus =
  | "never_verified"
  | "terminating_soon"
  | "stale"
  | "ok";

/**
 * The minimal projection of an active coverage the classifier inspects —
 * a LOCAL interface, never a DB row type. PHI posture: `memberIdTail` is
 * the last 4 of the member id only, never the full value.
 */
export interface CoverageInput {
  id: string;
  patientId: string;
  rank: string;
  payerName: string | null;
  /** Last 4 of the member id only — never the full value. */
  memberIdTail: string | null;
  verifiedAt: string | null;
  terminationDate: string | null;
}

export interface VerificationWorkItem extends CoverageInput {
  status: VerificationStatus;
  /** Whole days since verifiedAt, or null when never verified. */
  daysSinceVerified: number | null;
  /** Whole days until termination, or null when no termination date. */
  daysUntilTermination: number | null;
  /** Sort key — higher = more urgent. */
  priority: number;
}

export interface VerificationWorklist {
  items: VerificationWorkItem[];
  counts: {
    neverVerified: number;
    terminatingSoon: number;
    stale: number;
    ok: number;
    total: number;
  };
}

/**
 * Default re-verification cadence: a coverage last confirmed more than
 * this many days ago is considered "stale". Exported so callers (and the
 * SPA) band against the same number the route does.
 */
export const DEFAULT_ELIGIBILITY_STALE_DAYS = 30;

/** Default termination lookahead — flag a coverage terminating within N days. */
export const DEFAULT_ELIGIBILITY_TERMINATION_LOOKAHEAD_DAYS = 30;

const DAY_MS = 86_400_000;

// Urgency ordering. terminating_soon outranks never_verified because a
// coverage about to lapse is time-boxed; both beat stale; ok sinks.
const PRIORITY: Record<VerificationStatus, number> = {
  terminating_soon: 3,
  never_verified: 2,
  stale: 1,
  ok: 0,
};

/**
 * Whole calendar days between a YYYY-MM-DD(-ish) ISO string and a
 * millisecond instant, both truncated to their date. Returns null when the
 * `from` string is unparseable — an unreadable date never poisons the
 * countdown with NaN.
 */
function wholeDaysBetween(fromIso: string, toMs: number): number | null {
  const fromMs = Date.parse(fromIso.slice(0, 10));
  if (Number.isNaN(fromMs)) return null;
  const toDayMs = Date.parse(new Date(toMs).toISOString().slice(0, 10));
  return Math.round((toDayMs - fromMs) / DAY_MS);
}

/**
 * Pure: classify a SINGLE coverage by verification urgency, computing the
 * elapsed/remaining day counts and the resulting status band. Exposed so a
 * caller can band one coverage without building a full worklist (the SPA
 * uses this for a per-row badge). `staleDays` defaults to
 * {@link DEFAULT_ELIGIBILITY_STALE_DAYS} (30).
 */
export function classifyEligibilityRecency(
  coverage: CoverageInput,
  opts?: {
    staleDays?: number;
    terminationLookaheadDays?: number;
    nowMs?: number;
  },
): {
  status: VerificationStatus;
  daysSinceVerified: number | null;
  daysUntilTermination: number | null;
} {
  const staleDays = opts?.staleDays ?? DEFAULT_ELIGIBILITY_STALE_DAYS;
  const lookahead =
    opts?.terminationLookaheadDays ??
    DEFAULT_ELIGIBILITY_TERMINATION_LOOKAHEAD_DAYS;
  const nowMs = opts?.nowMs ?? Date.now();

  const daysSinceVerified =
    coverage.verifiedAt != null
      ? wholeDaysBetween(coverage.verifiedAt, nowMs)
      : null;
  const daysUntilTermination =
    coverage.terminationDate != null
      ? (() => {
          const d = wholeDaysBetween(coverage.terminationDate, nowMs);
          return d == null ? null : -d; // wholeDaysBetween gives elapsed; flip to remaining
        })()
      : null;

  let status: VerificationStatus;
  if (coverage.verifiedAt == null) {
    status = "never_verified";
  } else if (
    daysUntilTermination != null &&
    daysUntilTermination >= 0 &&
    daysUntilTermination <= lookahead
  ) {
    status = "terminating_soon";
  } else if (daysSinceVerified != null && daysSinceVerified > staleDays) {
    status = "stale";
  } else {
    status = "ok";
  }

  return { status, daysSinceVerified, daysUntilTermination };
}

/**
 * Pure: classify each active coverage by verification urgency and sort
 * most-urgent first (then by the sharper of "soonest termination" /
 * "longest stale"). No I/O — unit-tested directly.
 */
export function buildVerificationWorklist(
  coverages: readonly CoverageInput[],
  opts?: {
    staleDays?: number;
    terminationLookaheadDays?: number;
    asOf?: string;
  },
): VerificationWorklist {
  const staleDays = opts?.staleDays ?? DEFAULT_ELIGIBILITY_STALE_DAYS;
  const lookahead =
    opts?.terminationLookaheadDays ??
    DEFAULT_ELIGIBILITY_TERMINATION_LOOKAHEAD_DAYS;
  const asOfMs = opts?.asOf ? Date.parse(opts.asOf) : Date.now();
  const nowMs = Number.isNaN(asOfMs) ? Date.now() : asOfMs;

  const items: VerificationWorkItem[] = coverages.map((c) => {
    const { status, daysSinceVerified, daysUntilTermination } =
      classifyEligibilityRecency(c, {
        staleDays,
        terminationLookaheadDays: lookahead,
        nowMs,
      });
    return {
      ...c,
      status,
      daysSinceVerified,
      daysUntilTermination,
      priority: PRIORITY[status],
    };
  });

  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Tie-break: soonest termination first, else longest stale first.
    if (a.status === "terminating_soon" && b.status === "terminating_soon") {
      return (
        (a.daysUntilTermination ?? Infinity) -
        (b.daysUntilTermination ?? Infinity)
      );
    }
    return (b.daysSinceVerified ?? 0) - (a.daysSinceVerified ?? 0);
  });

  const counts = {
    neverVerified: 0,
    terminatingSoon: 0,
    stale: 0,
    ok: 0,
    total: items.length,
  };
  for (const i of items) {
    if (i.status === "never_verified") counts.neverVerified += 1;
    else if (i.status === "terminating_soon") counts.terminatingSoon += 1;
    else if (i.status === "stale") counts.stale += 1;
    else counts.ok += 1;
  }

  return { items, counts };
}
