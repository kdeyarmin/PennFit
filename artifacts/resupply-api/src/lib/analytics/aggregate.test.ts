// Pure-function tests for the analytics aggregators.
//
// Each helper is independently testable — no DB, no Date.now()
// inside the helper (the helper signatures take asOf/window in).
// The routes are the integration layer; if the routes ever change
// the queries, these tests still pin the math.

import { describe, it, expect } from "vitest";

import {
  PRODUCTIVE_ACTIONS,
  aggregateComplianceCohorts,
  aggregateCsrProductivity,
  aggregateResupplyFunnel,
} from "./aggregate";

describe("aggregateResupplyFunnel", () => {
  it("returns zeroed buckets for an empty list", () => {
    const r = aggregateResupplyFunnel([]);
    expect(r.total).toBe(0);
    expect(r.byStage.fulfilled).toBe(0);
    expect(r.fulfillmentRate).toBeNull();
    expect(r.dropOuts.declined).toBe(0);
  });

  it("counts each episode at exactly its current status", () => {
    const r = aggregateResupplyFunnel([
      { status: "outreach_pending" },
      { status: "outreach_pending" },
      { status: "awaiting_response" },
      { status: "confirmed" },
      { status: "fulfilled" },
      { status: "fulfilled" },
      { status: "fulfilled" },
    ]);
    expect(r.total).toBe(7);
    expect(r.byStage.outreach_pending).toBe(2);
    expect(r.byStage.awaiting_response).toBe(1);
    expect(r.byStage.confirmed).toBe(1);
    expect(r.byStage.fulfilled).toBe(3);
  });

  it("bucketizes drop-outs separately from funnel stages", () => {
    const r = aggregateResupplyFunnel([
      { status: "declined" },
      { status: "declined" },
      { status: "expired" },
      { status: "canceled" },
      { status: "fulfilled" },
    ]);
    expect(r.dropOuts.declined).toBe(2);
    expect(r.dropOuts.expired).toBe(1);
    expect(r.dropOuts.canceled).toBe(1);
    expect(r.byStage.fulfilled).toBe(1);
  });

  it("computes fulfillmentRate as fulfilled / total (incl. drop-outs)", () => {
    const r = aggregateResupplyFunnel([
      { status: "fulfilled" },
      { status: "fulfilled" },
      { status: "fulfilled" },
      { status: "declined" }, // counts toward total denominator
    ]);
    expect(r.fulfillmentRate).toBe(0.75);
  });

  it("ignores unknown statuses (forward-compatibility)", () => {
    const r = aggregateResupplyFunnel([
      { status: "future_state_X" },
      { status: "fulfilled" },
    ]);
    // Unknown contributes to total but not to either bucket.
    expect(r.total).toBe(2);
    expect(r.byStage.fulfilled).toBe(1);
    expect(r.dropOuts.declined).toBe(0);
    // Fulfillment rate still uses the full denominator.
    expect(r.fulfillmentRate).toBe(0.5);
  });
});

describe("aggregateComplianceCohorts — byMonth", () => {
  it("buckets patients by YYYY-MM prefix of signedUpAt", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "2026-01-15T00:00:00Z", qualifies: true, insurancePayer: "Medicare" },
      { signedUpAt: "2026-01-28T00:00:00Z", qualifies: false, insurancePayer: "Medicare" },
      { signedUpAt: "2026-02-03T00:00:00Z", qualifies: true, insurancePayer: "Medicare" },
    ]);
    expect(r.byMonth.map((b) => b.cohort)).toEqual(["2026-01", "2026-02"]);
    expect(r.byMonth[0]!.total).toBe(2);
    expect(r.byMonth[0]!.qualifying).toBe(1);
    expect(r.byMonth[0]!.rate).toBe(0.5);
    expect(r.byMonth[1]!.total).toBe(1);
    expect(r.byMonth[1]!.rate).toBe(1);
  });

  it("sorts cohorts ascending chronologically", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "2026-05-01", qualifies: false, insurancePayer: null },
      { signedUpAt: "2026-01-01", qualifies: true, insurancePayer: null },
      { signedUpAt: "2026-03-01", qualifies: true, insurancePayer: null },
    ]);
    expect(r.byMonth.map((b) => b.cohort)).toEqual([
      "2026-01",
      "2026-03",
      "2026-05",
    ]);
  });

  it("drops rows whose signedUpAt is malformed (< YYYY-MM-DD)", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "", qualifies: true, insurancePayer: "Medicare" },
      { signedUpAt: "2026-04-01", qualifies: true, insurancePayer: "Medicare" },
    ]);
    expect(r.byMonth).toHaveLength(1);
    expect(r.byMonth[0]!.cohort).toBe("2026-04");
  });
});

describe("aggregateComplianceCohorts — byPayer", () => {
  it("buckets null AND empty-string payer as Unspecified", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "2026-01-01", qualifies: true, insurancePayer: null },
      { signedUpAt: "2026-01-02", qualifies: false, insurancePayer: "Medicare" },
      { signedUpAt: "2026-01-03", qualifies: true, insurancePayer: "" },
      { signedUpAt: "2026-01-04", qualifies: false, insurancePayer: null },
    ]);
    const unspecified = r.byPayer.find((b) => b.payer === "Unspecified");
    expect(unspecified?.total).toBe(3);
    expect(unspecified?.qualifying).toBe(2);
    expect(unspecified?.rate).toBeCloseTo(2 / 3, 4);
  });

  it("sorts payers by descending total", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "2026-01-01", qualifies: true, insurancePayer: "Aetna" },
      { signedUpAt: "2026-01-02", qualifies: true, insurancePayer: "Medicare" },
      { signedUpAt: "2026-01-03", qualifies: true, insurancePayer: "Medicare" },
      { signedUpAt: "2026-01-04", qualifies: false, insurancePayer: "Medicare" },
    ]);
    expect(r.byPayer.map((b) => b.payer)).toEqual(["Medicare", "Aetna"]);
  });

  it("trims whitespace on payer name", () => {
    const r = aggregateComplianceCohorts([
      { signedUpAt: "2026-01-01", qualifies: true, insurancePayer: "  Medicare  " },
      { signedUpAt: "2026-01-02", qualifies: true, insurancePayer: "Medicare" },
    ]);
    expect(r.byPayer).toHaveLength(1);
    expect(r.byPayer[0]!.total).toBe(2);
  });
});

describe("aggregateCsrProductivity", () => {
  // Pick two known-productive actions for the fixtures.
  const productiveActions = Array.from(PRODUCTIVE_ACTIONS);
  const ACTION_A = productiveActions[0]!;
  const ACTION_B = productiveActions[1] ?? productiveActions[0]!;

  it("only counts actions from PRODUCTIVE_ACTIONS", () => {
    const r = aggregateCsrProductivity(
      [
        { operatorEmail: "csr@example.test", action: ACTION_A, occurredAt: "2026-05-10T12:00:00Z" },
        // Read-only action — must be filtered out
        { operatorEmail: "csr@example.test", action: "patient.view", occurredAt: "2026-05-10T12:01:00Z" },
        { operatorEmail: "csr@example.test", action: "audit.export", occurredAt: "2026-05-10T12:02:00Z" },
      ],
      14,
    );
    expect(r.totalActions).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.total).toBe(1);
  });

  it("buckets operators independently + sorts by total desc", () => {
    const r = aggregateCsrProductivity(
      [
        { operatorEmail: "a@example.test", action: ACTION_A, occurredAt: "2026-05-10T10:00:00Z" },
        { operatorEmail: "b@example.test", action: ACTION_A, occurredAt: "2026-05-10T10:00:00Z" },
        { operatorEmail: "b@example.test", action: ACTION_B, occurredAt: "2026-05-10T11:00:00Z" },
        { operatorEmail: "b@example.test", action: ACTION_A, occurredAt: "2026-05-10T12:00:00Z" },
      ],
      14,
    );
    expect(r.rows.map((row) => row.operator)).toEqual([
      "b@example.test",
      "a@example.test",
    ]);
    expect(r.rows[0]!.total).toBe(3);
    expect(r.rows[1]!.total).toBe(1);
  });

  it("buckets null operator as 'system'", () => {
    const r = aggregateCsrProductivity(
      [
        { operatorEmail: null, action: ACTION_A, occurredAt: "2026-05-10T10:00:00Z" },
      ],
      14,
    );
    expect(r.rows[0]!.operator).toBe("system");
  });

  it("tracks per-action counts and last-active date", () => {
    const r = aggregateCsrProductivity(
      [
        { operatorEmail: "csr@example.test", action: ACTION_A, occurredAt: "2026-05-08T10:00:00Z" },
        { operatorEmail: "csr@example.test", action: ACTION_A, occurredAt: "2026-05-10T10:00:00Z" },
        { operatorEmail: "csr@example.test", action: ACTION_B, occurredAt: "2026-05-09T10:00:00Z" },
      ],
      14,
    );
    expect(r.rows[0]!.byAction[ACTION_A]).toBe(2);
    expect(r.rows[0]!.byAction[ACTION_B]).toBe(1);
    // last-active is the max date across the operator's productive rows.
    expect(r.rows[0]!.lastActiveDate).toBe("2026-05-10");
  });

  it("returns empty rows array when nothing productive in the window", () => {
    const r = aggregateCsrProductivity(
      [
        { operatorEmail: "csr@example.test", action: "patient.view", occurredAt: "2026-05-10T10:00:00Z" },
      ],
      14,
    );
    expect(r.rows).toEqual([]);
    expect(r.totalActions).toBe(0);
    expect(r.windowDays).toBe(14);
  });
});
