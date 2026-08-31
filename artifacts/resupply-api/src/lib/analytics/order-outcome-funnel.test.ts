import { describe, expect, it } from "vitest";

import {
  ORDER_OUTCOME_STAGES,
  aggregateOrderOutcomeFunnel,
  type OutcomeClaimRow,
  type OutcomeEpisodeRow,
  type OutcomeFulfillmentRow,
} from "./order-outcome-funnel";

function run(input: {
  episodes?: OutcomeEpisodeRow[];
  fulfillments?: OutcomeFulfillmentRow[];
  claims?: OutcomeClaimRow[];
}) {
  return aggregateOrderOutcomeFunnel({
    episodes: input.episodes ?? [],
    fulfillments: input.fulfillments ?? [],
    claims: input.claims ?? [],
  });
}

function episode(over: Partial<OutcomeEpisodeRow> = {}): OutcomeEpisodeRow {
  return { id: "e1", status: "fulfilled", closedReason: "shipped", ...over };
}

function fulfillment(
  over: Partial<OutcomeFulfillmentRow> = {},
): OutcomeFulfillmentRow {
  return {
    id: "f1",
    episodeId: "e1",
    status: "shipped",
    shippedAt: "2026-03-05T00:00:00.000Z",
    ...over,
  };
}

function claim(over: Partial<OutcomeClaimRow> = {}): OutcomeClaimRow {
  return {
    fulfillmentId: "f1",
    status: "paid",
    denialReason: null,
    totalPaidCents: 4200,
    ...over,
  };
}

describe("aggregateOrderOutcomeFunnel — stage nesting", () => {
  it("keeps every stage a subset of the one before it", () => {
    const r = run({
      episodes: [
        episode({ id: "e1" }),
        episode({
          id: "e2",
          status: "declined",
          closedReason: "patient_declined",
        }),
        episode({ id: "e3", status: "confirmed", closedReason: null }),
      ],
      fulfillments: [fulfillment({ id: "f1", episodeId: "e1" })],
      claims: [claim({ fulfillmentId: "f1" })],
    });
    const counts = ORDER_OUTCOME_STAGES.map((s) => r.stages[s]);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it("counts a clean paid order all the way through", () => {
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [claim()],
    });
    expect(r.stages).toEqual({
      eligible: 1,
      confirmed: 1,
      fulfilled: 1,
      claimed: 1,
      accepted: 1,
      paid: 1,
    });
  });

  it("returns null rates rather than 0% on an empty window", () => {
    // "Nothing happened" and "everything failed" are different answers and
    // must not render the same.
    const r = run({});
    expect(r.stages.eligible).toBe(0);
    for (const value of Object.values(r.rates)) {
      expect(value).toBeNull();
    }
  });
});

describe("aggregateOrderOutcomeFunnel — fulfilled has two arms", () => {
  it("counts a cycle the grace sweep assumed shipped", () => {
    // The sweep closes `fulfilled` / `assumed_shipped` and NEVER stamps
    // shipped_at (that date becomes a claim's date of service). Requiring
    // ship evidence would make every no-ship-feed tenant look like a
    // total conversion failure.
    const r = run({
      episodes: [episode({ closedReason: "assumed_shipped" })],
      fulfillments: [fulfillment({ shippedAt: null, status: "queued" })],
    });
    expect(r.stages.fulfilled).toBe(1);
  });

  it("counts a real ship whose episode close-out failed", () => {
    // recordShipmentEvidence closes the episode fail-soft; the box still
    // left the building.
    const r = run({
      episodes: [episode({ status: "confirmed", closedReason: null })],
      fulfillments: [fulfillment()],
    });
    expect(r.stages.fulfilled).toBe(1);
  });
});

describe("aggregateOrderOutcomeFunnel — where orders are lost", () => {
  it("groups pre-ship losses by their recorded reason", () => {
    const r = run({
      episodes: [
        episode({
          id: "a",
          status: "declined",
          closedReason: "patient_declined",
        }),
        episode({
          id: "b",
          status: "declined",
          closedReason: "patient_declined",
        }),
        episode({
          id: "c",
          status: "canceled",
          closedReason: "patient_opted_out",
        }),
        episode({ id: "d", status: "expired", closedReason: "no_response" }),
        episode({
          id: "e",
          status: "expired",
          closedReason: "never_contacted",
        }),
      ],
    });
    expect(r.preShipLoss).toEqual({
      patient_declined: 2,
      patient_opted_out: 1,
      no_response: 1,
      never_contacted: 1,
    });
    expect(r.stages.confirmed).toBe(0);
  });

  it("buckets a pre-0538 closure as unknown rather than guessing", () => {
    const r = run({
      episodes: [episode({ status: "declined", closedReason: null })],
    });
    expect(r.preShipLoss).toEqual({ legacy_unknown: 1 });
  });

  it("surfaces shipped-and-never-billed", () => {
    // The most expensive silent failure in the chain, and there was no
    // surface for it anywhere before this.
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [],
    });
    expect(r.stages.fulfilled).toBe(1);
    expect(r.stages.claimed).toBe(0);
    expect(r.postShipLoss.unbilled).toBe(1);
  });

  it("separates a payer denial from a clearinghouse rejection", () => {
    // A 277CA rejection never reached adjudication and is usually fixable
    // and resubmittable; folding it into "denied" would send a biller
    // hunting for a medical-necessity problem that does not exist.
    const r = run({
      episodes: [episode({ id: "a" }), episode({ id: "b" })],
      fulfillments: [
        fulfillment({ id: "fa", episodeId: "a" }),
        fulfillment({ id: "fb", episodeId: "b" }),
      ],
      claims: [
        claim({
          fulfillmentId: "fa",
          status: "denied",
          totalPaidCents: 0,
          denialReason: "CARC 29 — The time limit for filing has expired",
        }),
        claim({ fulfillmentId: "fb", status: "rejected", totalPaidCents: 0 }),
      ],
    });
    expect(r.postShipLoss.denied).toBe(1);
    expect(r.postShipLoss.rejected).toBe(1);
  });
});

describe("aggregateOrderOutcomeFunnel — in-flight is not loss", () => {
  it("separates still-moving cycles from lost ones", () => {
    const r = run({
      episodes: [
        episode({ id: "a", status: "awaiting_response", closedReason: null }),
        episode({ id: "b", status: "address_hold", closedReason: null }),
        episode({ id: "c", status: "confirmed", closedReason: null }),
      ],
      fulfillments: [
        fulfillment({
          id: "fc",
          episodeId: "c",
          shippedAt: null,
          status: "queued",
        }),
      ],
    });
    expect(r.inFlight.awaitingResponse).toBe(1);
    expect(r.inFlight.addressHold).toBe(1);
    // Confirmed and unshipped — this is the bucket that means PacWare
    // never got the order.
    expect(r.inFlight.confirmedUnshipped).toBe(1);
    expect(r.preShipLoss).toEqual({});
  });

  it("counts an open claim as in flight, not as a denial", () => {
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [claim({ status: "submitted", totalPaidCents: 0 })],
    });
    expect(r.inFlight.claimOpen).toBe(1);
    expect(r.postShipLoss.denied).toBe(0);
    expect(r.stages.paid).toBe(0);
  });

  it("does not count an accepted-but-unpaid claim as paid", () => {
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [claim({ status: "accepted", totalPaidCents: 0 })],
    });
    expect(r.stages.accepted).toBe(1);
    expect(r.stages.paid).toBe(0);
  });

  it("counts a partial payment as paid", () => {
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [claim({ status: "partially_paid", totalPaidCents: 1200 })],
    });
    expect(r.stages.paid).toBe(1);
  });

  it("does not count a paid status with zero cents as paid", () => {
    // A zero-dollar remit is an adjudication outcome, not revenue.
    const r = run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [claim({ status: "paid", totalPaidCents: 0 })],
    });
    expect(r.stages.paid).toBe(0);
  });
});

describe("aggregateOrderOutcomeFunnel — CARC extraction", () => {
  const denied = (reason: string | null) =>
    run({
      episodes: [episode()],
      fulfillments: [fulfillment()],
      claims: [
        claim({
          status: "denied",
          totalPaidCents: 0,
          denialReason: reason,
        }),
      ],
    }).deniedByCarc;

  it("pulls the code out of the composed prose", () => {
    expect(denied("CARC 29 — The time limit for filing has expired")).toEqual([
      { code: "29", count: 1 },
    ]);
  });

  it("handles several codes on one denial", () => {
    const out = denied("CARC 16: missing information; CARC 50 — not covered");
    expect(out.map((d) => d.code).sort()).toEqual(["16", "50"]);
  });

  it("de-duplicates a code repeated in one reason", () => {
    expect(denied("CARC 97 and again CARC 97")).toEqual([
      { code: "97", count: 1 },
    ]);
  });

  it("buckets an unparseable reason rather than dropping the denial", () => {
    // A denial we cannot label is still a denial; silently dropping it
    // would make the totals lie.
    expect(denied("Payer says no")).toEqual([{ code: "uncoded", count: 1 }]);
    expect(denied(null)).toEqual([{ code: "uncoded", count: 1 }]);
  });

  it("sorts by count descending", () => {
    const r = run({
      episodes: [
        episode({ id: "a" }),
        episode({ id: "b" }),
        episode({ id: "c" }),
      ],
      fulfillments: [
        fulfillment({ id: "fa", episodeId: "a" }),
        fulfillment({ id: "fb", episodeId: "b" }),
        fulfillment({ id: "fc", episodeId: "c" }),
      ],
      claims: [
        claim({
          fulfillmentId: "fa",
          status: "denied",
          totalPaidCents: 0,
          denialReason: "CARC 29",
        }),
        claim({
          fulfillmentId: "fb",
          status: "denied",
          totalPaidCents: 0,
          denialReason: "CARC 29",
        }),
        claim({
          fulfillmentId: "fc",
          status: "denied",
          totalPaidCents: 0,
          denialReason: "CARC 16",
        }),
      ],
    });
    expect(r.deniedByCarc).toEqual([
      { code: "29", count: 2 },
      { code: "16", count: 1 },
    ]);
  });
});

describe("aggregateOrderOutcomeFunnel — multi-line episodes", () => {
  it("counts one episode once however many lines it has", () => {
    // A resupply cycle is normally four lines (mask, cushion, filters,
    // tubing). Counting per line would quadruple the funnel.
    const r = run({
      episodes: [episode()],
      fulfillments: [
        fulfillment({ id: "f1" }),
        fulfillment({ id: "f2" }),
        fulfillment({ id: "f3" }),
        fulfillment({ id: "f4" }),
      ],
      claims: [claim({ fulfillmentId: "f1" }), claim({ fulfillmentId: "f2" })],
    });
    expect(r.stages.eligible).toBe(1);
    expect(r.stages.fulfilled).toBe(1);
    expect(r.stages.claimed).toBe(1);
    expect(r.stages.paid).toBe(1);
  });
});
