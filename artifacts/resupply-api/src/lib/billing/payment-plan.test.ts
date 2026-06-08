import { describe, it, expect } from "vitest";

import {
  computePlanSummary,
  derivePlanStatus,
  generateInstallmentSchedule,
  type InstallmentRow,
} from "./payment-plan";

describe("generateInstallmentSchedule", () => {
  it("splits evenly and sums exactly to the total (remainder on first)", () => {
    const s = generateInstallmentSchedule({
      totalAmountCents: 10000,
      installmentCount: 3,
      frequency: "monthly",
      startDate: "2026-01-15",
    });
    expect(s).toHaveLength(3);
    expect(s.map((i) => i.amountCents)).toEqual([3334, 3333, 3333]);
    expect(s.reduce((t, i) => t + i.amountCents, 0)).toBe(10000);
    expect(s.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("advances monthly due dates and clamps end-of-month", () => {
    const s = generateInstallmentSchedule({
      totalAmountCents: 300,
      installmentCount: 3,
      frequency: "monthly",
      startDate: "2026-01-31",
    });
    // Jan 31 → Feb 28 (2026 not a leap year) → Mar 31.
    expect(s.map((i) => i.dueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("advances weekly / biweekly cadences", () => {
    const weekly = generateInstallmentSchedule({
      totalAmountCents: 300,
      installmentCount: 3,
      frequency: "weekly",
      startDate: "2026-01-01",
    });
    expect(weekly.map((i) => i.dueDate)).toEqual([
      "2026-01-01",
      "2026-01-08",
      "2026-01-15",
    ]);
    const biweekly = generateInstallmentSchedule({
      totalAmountCents: 300,
      installmentCount: 2,
      frequency: "biweekly",
      startDate: "2026-01-01",
    });
    expect(biweekly.map((i) => i.dueDate)).toEqual([
      "2026-01-01",
      "2026-01-15",
    ]);
  });
});

describe("computePlanSummary", () => {
  const rows: InstallmentRow[] = [
    { amountCents: 3334, status: "paid", dueDate: "2026-01-15" },
    { amountCents: 3333, status: "overdue", dueDate: "2026-02-15" },
    { amountCents: 3333, status: "scheduled", dueDate: "2026-03-15" },
  ];
  it("rolls up paid / remaining / overdue and next due", () => {
    const s = computePlanSummary(rows, "2026-02-20");
    expect(s.paidCents).toBe(3334);
    expect(s.remainingCents).toBe(6666);
    // Feb-15 is past 2026-02-20; Mar-15 is not.
    expect(s.overdueCount).toBe(1);
    expect(s.overdueCents).toBe(3333);
    expect(s.nextDueDate).toBe("2026-02-15");
  });
  it("ignores waived installments in remaining", () => {
    const s = computePlanSummary(
      [
        { amountCents: 100, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 100, status: "waived", dueDate: "2026-02-01" },
      ],
      "2026-03-01",
    );
    expect(s.remainingCents).toBe(0);
    expect(s.nextDueDate).toBeNull();
  });
});

describe("derivePlanStatus", () => {
  it("completed only when all installments are paid or waived", () => {
    expect(
      derivePlanStatus([
        { amountCents: 1, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 1, status: "waived", dueDate: "2026-02-01" },
      ]),
    ).toBe("completed");
    expect(
      derivePlanStatus([
        { amountCents: 1, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 1, status: "scheduled", dueDate: "2026-02-01" },
      ]),
    ).toBe("active");
  });
});
