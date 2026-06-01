// Cost & margin math — pure value-object helpers (ADR 008: no I/O).
//
// The data foundation for cost capture lands in migration 0193; these
// functions are the shared, side-effect-free core every owner-facing
// margin surface (gross-margin dashboard, payer-mix profitability,
// inventory turnover, the cash-flow forecast — see
// docs/feature-roadmap-2026-05-31.md) computes through, so the rules for
// "what counts as margin" live in exactly one tested place.
//
// Money is always integer cents. Cost is OPTIONAL: a line whose SKU has
// no recorded cost reads back as "cost unknown" rather than zero.
// Treating an unknown cost as $0 would silently report 100% margin —
// the single most dangerous rounding error in a COGS report — so every
// helper distinguishes "cost is known and happens to be 0" from "cost
// is unknown".

export interface MarginInput {
  /** Gross (extended) revenue for the line, in integer cents (>= 0). */
  revenueCents: number;
  /**
   * Unit cost in integer cents, or null/undefined when no cost has been
   * recorded for the SKU. `0` is a valid KNOWN cost; null is UNKNOWN.
   */
  unitCostCents?: number | null;
  /** Units sold. Defaults to 1; clamped to a positive integer. */
  quantity?: number;
}

export interface MarginResult {
  revenueCents: number;
  /** Extended cost (unitCost × quantity), or null when cost is unknown. */
  costCents: number | null;
  /** revenue − cost, or null when cost is unknown. Negative = a loss. */
  marginCents: number | null;
  /**
   * marginCents / revenueCents as a raw ratio (e.g. 0.42 = 42%), or null
   * when cost is unknown OR revenue is 0 (margin % is undefined with no
   * revenue). Callers format as a percentage; we keep the raw ratio so
   * no precision is lost before display.
   */
  marginRatio: number | null;
  /** True when a cost was supplied (even if 0); false when unknown. */
  costKnown: boolean;
}

function clampCents(n: number): number {
  // Money is integer cents and never negative on an input amount.
  return Math.max(0, Math.trunc(n));
}

function clampQuantity(q: number | undefined): number {
  if (q == null || !Number.isFinite(q)) return 1;
  const truncated = Math.trunc(q);
  return truncated > 0 ? truncated : 1;
}

/**
 * Compute revenue/cost/margin for a single line. Unknown cost
 * (null/undefined) propagates as null margin + costKnown=false rather
 * than collapsing to a 100%-margin lie.
 */
export function computeMargin(input: MarginInput): MarginResult {
  const revenueCents = clampCents(input.revenueCents);
  const quantity = clampQuantity(input.quantity);
  const costKnown = input.unitCostCents != null;

  const costCents = costKnown
    ? clampCents(input.unitCostCents as number) * quantity
    : null;
  const marginCents = costCents == null ? null : revenueCents - costCents;
  const marginRatio =
    marginCents == null || revenueCents === 0
      ? null
      : marginCents / revenueCents;

  return { revenueCents, costCents, marginCents, marginRatio, costKnown };
}

export interface MarginAggregate {
  lineCount: number;
  /** Revenue across ALL lines, costed or not. */
  revenueCents: number;
  /** Revenue of lines that HAVE a known cost (the basis for margin %). */
  costedRevenueCents: number;
  /** Revenue of lines with NO recorded cost — the blind spot to disclose. */
  uncostedRevenueCents: number;
  /** Sum of known extended costs. */
  costCents: number;
  /** costedRevenueCents − costCents (margin over costed lines only). */
  marginCents: number;
  /**
   * marginCents / costedRevenueCents, or null when no costed revenue
   * exists. Deliberately computed over costed revenue ONLY so an
   * uncosted line can't masquerade as pure margin.
   */
  marginRatio: number | null;
  linesWithKnownCost: number;
  linesWithUnknownCost: number;
}

/**
 * Fold a list of lines into a margin rollup that keeps the
 * known-cost / unknown-cost split explicit, so a dashboard can say
 * "X% margin on the $Y of revenue where we know cost; $Z has no cost
 * recorded" instead of quietly averaging a guess into the headline.
 */
export function aggregateMargin(
  lines: readonly MarginInput[],
): MarginAggregate {
  const agg: MarginAggregate = {
    lineCount: 0,
    revenueCents: 0,
    costedRevenueCents: 0,
    uncostedRevenueCents: 0,
    costCents: 0,
    marginCents: 0,
    marginRatio: null,
    linesWithKnownCost: 0,
    linesWithUnknownCost: 0,
  };

  for (const line of lines) {
    const r = computeMargin(line);
    agg.lineCount += 1;
    agg.revenueCents += r.revenueCents;
    if (r.costKnown && r.costCents != null) {
      agg.costedRevenueCents += r.revenueCents;
      agg.costCents += r.costCents;
      agg.linesWithKnownCost += 1;
    } else {
      agg.uncostedRevenueCents += r.revenueCents;
      agg.linesWithUnknownCost += 1;
    }
  }

  agg.marginCents = agg.costedRevenueCents - agg.costCents;
  agg.marginRatio =
    agg.costedRevenueCents === 0
      ? null
      : agg.marginCents / agg.costedRevenueCents;

  return agg;
}
