import { describe, expect, it } from "vitest";

import {
  computePlanSummary,
  derivePlanStatus,
  generateInstallmentSchedule,
  type InstallmentRow,
} from "./payment-plan";

describe("generateInstallmentSchedule", () => {
  it("splits evenly and puts the remainder on the first installment", () => {
    const s = generateInstallmentSchedule({
      totalAmountCents: 10_000,
      installmentCount: 3,
      frequency: "monthly",
      startDate: "2026-01-15",
    });
    expect(s.map((i) => i.amountCents)).toEqual([3334, 3333, 3333]);
    // Always sums EXACTLY to the total — no lost or phantom cents.
    expect(s.reduce((sum, i) => sum + i.amountCents, 0)).toBe(10_000);
    expect(s.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("advances monthly due dates and clamps end-of-month", () => {
    const s = generateInstallmentSchedule({
      totalAmountCents: 300,
      installmentCount: 3,
      frequency: "monthly",
      startDate: "2026-01-31",
    });
    // Jan-31 + 1mo clamps to Feb-28 (2026 is not a leap year), not Mar-03.
    expect(s.map((i) => i.dueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("returns an empty schedule for a non-positive or non-finite count", () => {
    const base = {
      totalAmountCents: 10_000,
      frequency: "monthly" as const,
      startDate: "2026-01-15",
    };
    expect(
      generateInstallmentSchedule({ ...base, installmentCount: 0 }),
    ).toEqual([]);
    expect(
      generateInstallmentSchedule({ ...base, installmentCount: -3 }),
    ).toEqual([]);
    expect(
      generateInstallmentSchedule({
        ...base,
        installmentCount: Number.NaN,
      }),
    ).toEqual([]);
  });

  it("clamps a non-finite total to 0 (no NaN amounts)", () => {
    const s = generateInstallmentSchedule({
      totalAmountCents: Number.POSITIVE_INFINITY,
      installmentCount: 3,
      frequency: "monthly",
      startDate: "2026-01-15",
    });
    expect(s.every((i) => Number.isFinite(i.amountCents))).toBe(true);
    expect(s.reduce((sum, i) => sum + i.amountCents, 0)).toBe(0);
  });

  it("advances weekly and biweekly cadences", () => {
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
    { amountCents: 3334, status: "paid", dueDate: "2026-01-01" },
    { amountCents: 3333, status: "overdue", dueDate: "2026-02-01" },
    { amountCents: 3333, status: "scheduled", dueDate: "2026-03-01" },
  ];

  it("rolls up paid / remaining / overdue and the next due date", () => {
    const s = computePlanSummary(rows, "2026-02-20");
    expect(s.paidCents).toBe(3334);
    expect(s.remainingCents).toBe(6666); // overdue + scheduled
    expect(s.overdueCount).toBe(1);
    expect(s.overdueCents).toBe(3333);
    expect(s.nextDueDate).toBe("2026-02-01"); // earliest unpaid
  });

  it("ignores waived installments in the remaining balance", () => {
    const s = computePlanSummary(
      [
        { amountCents: 100, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 100, status: "waived", dueDate: "2026-02-01" },
        { amountCents: 100, status: "scheduled", dueDate: "2026-03-01" },
      ],
      "2026-01-15",
    );
    expect(s.paidCents).toBe(100);
    expect(s.remainingCents).toBe(100); // the waived 100 is not owed
    expect(s.overdueCount).toBe(0);
  });
});

describe("derivePlanStatus", () => {
  it("is active until every installment is paid or waived", () => {
    expect(derivePlanStatus([])).toBe("active");
    expect(
      derivePlanStatus([
        { amountCents: 100, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 100, status: "scheduled", dueDate: "2026-02-01" },
      ]),
    ).toBe("active");
  });

  it("is completed when all installments are paid or waived", () => {
    expect(
      derivePlanStatus([
        { amountCents: 100, status: "paid", dueDate: "2026-01-01" },
        { amountCents: 100, status: "waived", dueDate: "2026-02-01" },
      ]),
    ).toBe("completed");
  });
});
