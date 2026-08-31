// Order-outcome funnel — pure aggregation.
//
// WHY THIS EXISTS
// ---------------
// The platform measured the resupply funnel and the claim funnel in two
// places that never touched:
//
//   * lib/analytics/aggregate.ts stops at `fulfilled`.
//   * The billing dashboards start at a claim and know nothing about the
//     episode it came from.
//
// So nobody could answer the question the business actually asks — of the
// patients who were due this quarter, how many ended up as money — nor,
// when the answer was bad, at which step it went wrong. The join key has
// existed since migration 0118 (`insurance_claims.fulfillment_id`) and
// nothing used it.
//
// This reduces one window into:
//
//   eligible → confirmed → fulfilled → claimed → accepted → paid
//
// with the drop-out REASON at each stage, which is the part that makes it
// actionable: "31 didn't convert" is a number, "18 declined, 9 never
// answered, 4 lost coverage" is a to-do list.
//
// PURE: no DB, no Date.now(), no logging. The route does the reads (three
// chunked, paged PostgREST passes — there are no JOINs) and this is the
// math. Same contract as reorder-funnel.ts beside it.

/** Stages, in order. Each is a strict subset of the one before it. */
export const ORDER_OUTCOME_STAGES = [
  "eligible",
  "confirmed",
  "fulfilled",
  "claimed",
  "accepted",
  "paid",
] as const;

export type OrderOutcomeStage = (typeof ORDER_OUTCOME_STAGES)[number];

export interface OutcomeEpisodeRow {
  id: string;
  status: string;
  /** Null on anything still open, AND on rows closed before the close-out
   *  record existed (migration 0538). Those are genuinely unknown and are
   *  bucketed as such rather than back-filled with a guess. */
  closedReason: string | null;
}

export interface OutcomeFulfillmentRow {
  id: string;
  episodeId: string;
  status: string;
  shippedAt: string | null;
}

export interface OutcomeClaimRow {
  fulfillmentId: string;
  status: string;
  /** Composed prose from the ERA reconciler, e.g.
   *  "CARC 29 — The time limit for filing has expired". Parsed for codes
   *  below; never grouped on verbatim. */
  denialReason: string | null;
  totalPaidCents: number;
}

export interface OrderOutcomeFunnelResult {
  stages: Record<OrderOutcomeStage, number>;
  /** Step-to-step conversion. `null` where the denominator is zero — a
   *  rate of 0% and "no data" are different answers and must not render
   *  the same. */
  rates: {
    confirmedOfEligible: number | null;
    fulfilledOfConfirmed: number | null;
    claimedOfFulfilled: number | null;
    acceptedOfClaimed: number | null;
    paidOfAccepted: number | null;
  };
  /** Cycles that ended before anything shipped, by reason.
   *  `legacy_unknown` = closed before the reason column existed. */
  preShipLoss: Record<string, number>;
  /** Shipped, then lost downstream. */
  postShipLoss: {
    /** Shipped and never billed. Usually the biggest single number here,
     *  and the one nobody sees today. */
    unbilled: number;
    denied: number;
    rejected: number;
    closedUnpaid: number;
  };
  /** Denials by CARC code, descending. CODES ONLY — the route joins the
   *  human description from the global denial_codes catalog. */
  deniedByCarc: Array<{ code: string; count: number }>;
  /** Still moving. Not losses, and must not be counted as such. */
  inFlight: {
    awaitingResponse: number;
    confirmedUnshipped: number;
    addressHold: number;
    claimOpen: number;
  };
  /**
   * Cycles the grace sweep advanced with NO shipment evidence.
   *
   * Neither shipped nor lost: the sweep deliberately never invents a ship
   * date, so nobody knows whether anything left the warehouse. Counted
   * apart from `stages.fulfilled` because calling it shipped would then
   * count it as shipped-but-unbilled product loss — an expensive number
   * reported against product that may not exist.
   *
   * The size of this bucket IS the argument for connecting a ship feed:
   * it is exactly the population the platform cannot account for.
   */
  unverified: {
    assumedShipped: number;
  };
}

/** Claim statuses that mean the payer accepted it (or better). */
const ACCEPTED_CLAIM_STATUSES = new Set(["accepted", "partially_paid", "paid"]);
/** …and that money actually arrived. */
const PAID_CLAIM_STATUSES = new Set(["partially_paid", "paid"]);
/** Still in flight with the payer. */
const OPEN_CLAIM_STATUSES = new Set([
  "draft",
  "submitting",
  "submitted",
  "accepted",
  "appealed",
]);

/**
 * Pull CARC codes out of the composed denial prose.
 *
 * Deliberately NOT a group-by on the free text: that has unbounded
 * cardinality, and it would put payer prose (which can quote claim and
 * member detail) into an analytics response. Codes are a bounded set of
 * ~50 catalog entries and carry no PHI.
 */
const CARC_RE = /\bCARC[\s:]*(\d{1,3})\b/gi;

function extractCarcCodes(reason: string | null): string[] {
  // A denial we cannot label is still a denial — including one with no
  // reason recorded at all (a manual status change, or an ERA whose
  // adjustment segments did not parse). Returning an empty list here
  // would drop it from the CARC breakdown while it still counted in
  // `postShipLoss.denied`, so the two numbers on the page would disagree
  // and neither could be trusted.
  if (!reason) return ["uncoded"];
  const out = new Set<string>();
  for (const m of reason.matchAll(CARC_RE)) {
    if (m[1]) out.add(m[1]);
  }
  return out.size > 0 ? [...out] : ["uncoded"];
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function aggregateOrderOutcomeFunnel(input: {
  episodes: readonly OutcomeEpisodeRow[];
  fulfillments: readonly OutcomeFulfillmentRow[];
  claims: readonly OutcomeClaimRow[];
}): OrderOutcomeFunnelResult {
  const fulfillmentsByEpisode = new Map<string, OutcomeFulfillmentRow[]>();
  for (const f of input.fulfillments) {
    fulfillmentsByEpisode.set(f.episodeId, [
      ...(fulfillmentsByEpisode.get(f.episodeId) ?? []),
      f,
    ]);
  }
  const claimsByFulfillment = new Map<string, OutcomeClaimRow[]>();
  for (const c of input.claims) {
    claimsByFulfillment.set(c.fulfillmentId, [
      ...(claimsByFulfillment.get(c.fulfillmentId) ?? []),
      c,
    ]);
  }

  const stages: Record<OrderOutcomeStage, number> = {
    eligible: 0,
    confirmed: 0,
    fulfilled: 0,
    claimed: 0,
    accepted: 0,
    paid: 0,
  };
  const preShipLoss: Record<string, number> = {};
  const postShipLoss = {
    unbilled: 0,
    denied: 0,
    rejected: 0,
    closedUnpaid: 0,
  };
  const unverified = { assumedShipped: 0 };
  const inFlight = {
    awaitingResponse: 0,
    confirmedUnshipped: 0,
    addressHold: 0,
    claimOpen: 0,
  };
  const carcCounts = new Map<string, number>();

  for (const ep of input.episodes) {
    stages.eligible += 1;

    const fulfillments = fulfillmentsByEpisode.get(ep.id) ?? [];

    // CONFIRMED: the patient agreed. Either the episode says so, or a
    // fulfillment exists (which only a confirm creates) — the second arm
    // catches a confirm whose status write lost a race.
    const isConfirmed =
      ep.status === "confirmed" ||
      ep.status === "fulfilled" ||
      fulfillments.length > 0;

    // FULFILLED: the supplies went out, and we KNOW they did.
    //
    // Two arms, and one deliberate exclusion. A real ship whose episode
    // close-out lost a race has evidence but no `fulfilled` status, so
    // evidence alone is enough. A `fulfilled` status is enough on its own
    // too — EXCEPT when the grace sweep put it there, because that close
    // means "we gave up waiting", not "it shipped". The sweep must never
    // invent a ship date, and this must not invent one on its behalf.
    const hasShipEvidence = fulfillments.some((f) => f.shippedAt !== null);
    const isAssumed =
      !hasShipEvidence &&
      ep.status === "fulfilled" &&
      ep.closedReason === "assumed_shipped";
    const isFulfilled =
      hasShipEvidence || (ep.status === "fulfilled" && !isAssumed);

    if (!isConfirmed) {
      // Ended, or still moving, before the patient ever agreed.
      if (
        ep.status === "awaiting_response" ||
        ep.status === "outreach_pending"
      ) {
        inFlight.awaitingResponse += 1;
      } else if (ep.status === "address_hold") {
        inFlight.addressHold += 1;
      } else {
        const reason = ep.closedReason ?? "legacy_unknown";
        preShipLoss[reason] = (preShipLoss[reason] ?? 0) + 1;
      }
      continue;
    }

    stages.confirmed += 1;

    if (isAssumed) {
      // The patient agreed — that much is real, so it counts as
      // confirmed. Everything after this stage is unknown for them.
      unverified.assumedShipped += 1;
      continue;
    }

    if (!isFulfilled) {
      // Confirmed and sitting there. Not a loss yet — but this is the
      // bucket that means PacWare never got the order.
      inFlight.confirmedUnshipped += 1;
      continue;
    }

    stages.fulfilled += 1;

    const claims = fulfillments.flatMap(
      (f) => claimsByFulfillment.get(f.id) ?? [],
    );
    if (claims.length === 0) {
      // Shipped and never billed. The single most expensive silent
      // failure in the chain, and there was no surface for it.
      postShipLoss.unbilled += 1;
      continue;
    }

    stages.claimed += 1;

    const accepted = claims.some((c) => ACCEPTED_CLAIM_STATUSES.has(c.status));
    const paid = claims.some(
      (c) => PAID_CLAIM_STATUSES.has(c.status) && c.totalPaidCents > 0,
    );

    if (accepted) stages.accepted += 1;
    if (paid) {
      stages.paid += 1;
      continue;
    }

    // Not paid. Say why.
    if (claims.some((c) => c.status === "denied")) {
      postShipLoss.denied += 1;
      for (const c of claims) {
        if (c.status !== "denied") continue;
        for (const code of extractCarcCodes(c.denialReason)) {
          carcCounts.set(code, (carcCounts.get(code) ?? 0) + 1);
        }
      }
    } else if (claims.some((c) => c.status === "rejected")) {
      // A 277CA front-end rejection is NOT a payer denial — it never
      // reached adjudication, and it is usually fixable and resubmittable.
      postShipLoss.rejected += 1;
    } else if (claims.every((c) => c.status === "closed")) {
      postShipLoss.closedUnpaid += 1;
    } else if (claims.some((c) => OPEN_CLAIM_STATUSES.has(c.status))) {
      inFlight.claimOpen += 1;
    }
  }

  return {
    stages,
    rates: {
      confirmedOfEligible: rate(stages.confirmed, stages.eligible),
      fulfilledOfConfirmed: rate(stages.fulfilled, stages.confirmed),
      claimedOfFulfilled: rate(stages.claimed, stages.fulfilled),
      acceptedOfClaimed: rate(stages.accepted, stages.claimed),
      paidOfAccepted: rate(stages.paid, stages.accepted),
    },
    preShipLoss,
    postShipLoss,
    deniedByCarc: [...carcCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    inFlight,
    unverified,
  };
}
