// ADR outcome analytics — pure aggregation (ADR 008: no I/O).
//
// Given the responded/closed ADRs (their contractor source + outcome), roll up
// a win rate and a per-source breakdown. "Won" = the supplier kept the money:
// a favorable or partial outcome. Pending outcomes don't count toward the rate
// (the audit isn't decided yet) but are tallied per source so the worklist can
// show how much is still in flight.

export type AdrOutcomeValue =
  | "pending"
  | "favorable"
  | "partial"
  | "unfavorable"
  | "withdrawn";

export interface AdrOutcomeRow {
  source: string;
  outcome: string;
}

export interface AdrSourceBucket {
  source: string;
  total: number;
  favorable: number;
  partial: number;
  unfavorable: number;
  pending: number;
}

export interface AdrOutcomeAnalytics {
  totals: {
    responded: number;
    decided: number;
    favorable: number;
    partial: number;
    unfavorable: number;
    /** (favorable + partial) / decided, or null when nothing is decided. */
    winRate: number | null;
  };
  /** Per-source buckets, busiest first. */
  bySource: AdrSourceBucket[];
}

function emptyBucket(source: string): AdrSourceBucket {
  return {
    source,
    total: 0,
    favorable: 0,
    partial: 0,
    unfavorable: 0,
    pending: 0,
  };
}

/** Aggregate responded ADR rows into a win rate + per-source breakdown. */
export function aggregateAdrOutcomes(
  rows: readonly AdrOutcomeRow[],
): AdrOutcomeAnalytics {
  const bySource = new Map<string, AdrSourceBucket>();
  let favorable = 0;
  let partial = 0;
  let unfavorable = 0;
  let decided = 0;

  for (const r of rows) {
    const bucket = bySource.get(r.source) ?? emptyBucket(r.source);
    bucket.total += 1;
    switch (r.outcome) {
      case "favorable":
        bucket.favorable += 1;
        favorable += 1;
        decided += 1;
        break;
      case "partial":
        bucket.partial += 1;
        partial += 1;
        decided += 1;
        break;
      case "unfavorable":
        bucket.unfavorable += 1;
        unfavorable += 1;
        decided += 1;
        break;
      default:
        // pending / withdrawn / anything else — not a decided win or loss.
        bucket.pending += 1;
        break;
    }
    bySource.set(r.source, bucket);
  }

  return {
    totals: {
      responded: rows.length,
      decided,
      favorable,
      partial,
      unfavorable,
      winRate: decided > 0 ? (favorable + partial) / decided : null,
    },
    bySource: Array.from(bySource.values()).sort((a, b) => b.total - a.total),
  };
}
