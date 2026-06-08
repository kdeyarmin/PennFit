import { describe, it, expect } from "vitest";

import { renderIif, type QuickbooksRowInput } from "./quickbooks-export";

const rows: QuickbooksRowInput[] = [
  {
    txnId: "TXN-1",
    date: "2026-05-01",
    amountUsd: 100,
    kind: "ORDER",
    memo: "m",
    customerKey: "cust_a",
  },
  {
    txnId: "TXN-2",
    date: "2026-05-02",
    amountUsd: -25,
    kind: "REFUND",
    memo: "m",
    customerKey: "cust_b",
  },
];

describe("renderIif — configurable accounts (owner #O3)", () => {
  it("uses the historical defaults when no accounts config is given", () => {
    const iif = renderIif({
      from: "2026-05-01",
      to: "2026-05-31",
      practiceName: "P",
      rows,
    });
    expect(iif).toContain("Stripe Clearing");
    expect(iif).toContain("Sales:Online Orders");
    expect(iif).toContain("Sales Returns and Allowances");
  });

  it("substitutes configured deposit/revenue/refund account names", () => {
    const iif = renderIif({
      from: "2026-05-01",
      to: "2026-05-31",
      practiceName: "P",
      rows,
      accounts: {
        deposit: "Bank:Clearing",
        revenue: "Income:Online",
        refund: "Income:Refunds",
      },
    });
    expect(iif).toContain("Bank:Clearing");
    expect(iif).toContain("Income:Online");
    expect(iif).toContain("Income:Refunds");
    expect(iif).not.toContain("Stripe Clearing"); // default deposit gone
    expect(iif).not.toContain("Sales:Online Orders"); // default revenue gone
  });

  it("still honours a per-row incomeAccount override", () => {
    const iif = renderIif({
      from: "2026-05-01",
      to: "2026-05-31",
      practiceName: "P",
      rows: [{ ...rows[0]!, incomeAccount: "Patient Payments" }],
      accounts: { revenue: "Income:Online" },
    });
    expect(iif).toContain("Patient Payments");
    expect(iif).not.toContain("Income:Online");
  });
});
