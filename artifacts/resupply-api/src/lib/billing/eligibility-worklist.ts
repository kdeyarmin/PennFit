// Pure eligibility re-verification ranking (Biller #31).
//
// Extracted from the worklist route so both the route (read half) and
// the batch runner (write half) can share the exact same urgency
// classification without a route↔lib import cycle. No I/O — unit-tested
// directly via the route's test and the batch test.

export type VerificationStatus =
  | "never_verified"
  | "terminating_soon"
  | "stale"
  | "ok";

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

const DAY_MS = 86_400_000;

// Urgency ordering. terminating_soon outranks never_verified because a
// coverage about to lapse is time-boxed; both beat stale; ok sinks.
const PRIORITY: Record<VerificationStatus, number> = {
  terminating_soon: 3,
  never_verified: 2,
  stale: 1,
  ok: 0,
};

function wholeDaysBetween(fromIso: string, toMs: number): number | null {
  const fromMs = Date.parse(fromIso.slice(0, 10));
  if (Number.isNaN(fromMs)) return null;
  const toDayMs = Date.parse(new Date(toMs).toISOString().slice(0, 10));
  return Math.round((toDayMs - fromMs) / DAY_MS);
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
  const staleDays = opts?.staleDays ?? 30;
  const lookahead = opts?.terminationLookaheadDays ?? 30;
  const asOfMs = opts?.asOf ? Date.parse(opts.asOf) : Date.now();
  const nowMs = Number.isNaN(asOfMs) ? Date.now() : asOfMs;

  const items: VerificationWorkItem[] = coverages.map((c) => {
    const daysSinceVerified =
      c.verifiedAt != null ? wholeDaysBetween(c.verifiedAt, nowMs) : null;
    const daysUntilTermination =
      c.terminationDate != null
        ? (() => {
            const d = wholeDaysBetween(c.terminationDate, nowMs);
            return d == null ? null : -d; // wholeDaysBetween gives elapsed; flip to remaining
          })()
        : null;

    let status: VerificationStatus;
    if (c.verifiedAt == null) {
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
