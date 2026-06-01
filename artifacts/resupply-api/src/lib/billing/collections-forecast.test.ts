// Tests for Owner #4 slice 1 — the pure AR collections projection.

import { describe, it, expect } from "vitest";

import {
  projectClaimCollections,
  type OutstandingClaim,
} from "./collections-forecast";

const ASOF = "2026-06-01T00:00:00Z";
const day = (n: number) =>
  new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();

describe("projectClaimCollections", () => {
  it("uses allowed when set, billed×ratio otherwise, ×collectionProbability", () => {
    const claims: OutstandingClaim[] = [
      // allowed known → 10000 × 0.95 = 9500
      {
        status: "accepted",
        total_billed_cents: 20000,
        total_allowed_cents: 10000,
        submitted_at: day(40),
      },
      // allowed unknown → billed 20000 × 0.5 × 0.95 = 9500
      {
        status: "submitted",
        total_billed_cents: 20000,
        total_allowed_cents: 0,
        submitted_at: day(40),
      },
    ];
    const f = projectClaimCollections(claims, { asOf: ASOF });
    expect(f.totalExpectedCents).toBe(19000);
    expect(f.outstandingClaimCount).toBe(2);
  });

  it("ignores non-outstanding statuses", () => {
    const claims: OutstandingClaim[] = [
      {
        status: "paid",
        total_billed_cents: 10000,
        total_allowed_cents: 8000,
        submitted_at: day(10),
      },
      {
        status: "draft",
        total_billed_cents: 10000,
        total_allowed_cents: 0,
        submitted_at: null,
      },
      {
        status: "denied",
        total_billed_cents: 10000,
        total_allowed_cents: 0,
        submitted_at: day(10),
      },
    ];
    const f = projectClaimCollections(claims, { asOf: ASOF });
    expect(f.outstandingClaimCount).toBe(0);
    expect(f.totalExpectedCents).toBe(0);
  });

  it("buckets by lands-in-days = expectedDaysToPay − age", () => {
    const claims: OutstandingClaim[] = [
      // age 40, expectedDaysToPay 45 → lands in 5 → ≤30 bucket
      {
        status: "accepted",
        total_billed_cents: 0,
        total_allowed_cents: 1000,
        submitted_at: day(40),
      },
      // age 0, lands in 45 → 31–60 bucket
      {
        status: "accepted",
        total_billed_cents: 0,
        total_allowed_cents: 1000,
        submitted_at: day(0),
      },
    ];
    const f = projectClaimCollections(claims, {
      asOf: ASOF,
      expectedDaysToPay: 45,
      collectionProbability: 1,
    });
    const within30 = f.horizons.find((h) => h.withinDays === 30)!;
    const within60 = f.horizons.find((h) => h.withinDays === 60)!;
    expect(within30.expectedCents).toBe(1000);
    expect(within30.claimCount).toBe(1);
    expect(within60.expectedCents).toBe(1000);
  });

  it("an old claim past expectedDaysToPay lands in the ≤30 (lands-now) bucket", () => {
    const claims: OutstandingClaim[] = [
      {
        status: "submitted",
        total_billed_cents: 0,
        total_allowed_cents: 5000,
        submitted_at: day(120), // age ≫ expectedDaysToPay → lands in 0 days
      },
    ];
    const f = projectClaimCollections(claims, {
      asOf: ASOF,
      expectedDaysToPay: 45,
      collectionProbability: 1,
    });
    const within30 = f.horizons.find((h) => h.withinDays === 30)!;
    expect(within30.expectedCents).toBe(5000);
  });

  it("echoes the assumptions used", () => {
    const f = projectClaimCollections([], {
      asOf: ASOF,
      expectedDaysToPay: 30,
      defaultAllowedRatio: 0.4,
      collectionProbability: 0.9,
    });
    expect(f.assumptions).toEqual({
      expectedDaysToPay: 30,
      defaultAllowedRatio: 0.4,
      collectionProbability: 0.9,
      asOf: new Date(ASOF).toISOString(),
    });
    expect(f.totalExpectedCents).toBe(0);
  });
});
