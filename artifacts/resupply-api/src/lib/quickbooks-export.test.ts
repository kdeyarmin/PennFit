// Tests for the QuickBooks export emitters.
//
// IIF (Desktop): assert each transaction renders one !TRNS row,
// one !SPL row with the opposite-sign amount, and one ENDTRNS
// terminator. Refund kinds set the TRNSTYPE to CREDIT MEMO and the
// SPL account to Sales Returns and Allowances.
//
// QBO CSV (Online): assert the header line matches the QBO import
// wizard's expected columns and each row carries the absolute
// amount + "Sales Receipt" / "Credit Memo" Type column.

import { describe, it, expect } from "vitest";

import {
  customerKeyForId,
  renderIif,
  renderQboCsv,
  type QuickbooksExportInput,
} from "./quickbooks-export";

function sampleInput(): QuickbooksExportInput {
  return {
    from: "2026-04-01",
    to: "2026-04-30",
    practiceName: "PennPaps",
    rows: [
      {
        txnId: "ORD-abc123",
        date: "2026-04-15",
        amountUsd: 250.0,
        kind: "ORDER",
        memo: "cs_test_session_1",
        customerKey: "cust-abc123",
      },
      {
        txnId: "RFD-def456",
        date: "2026-04-22",
        amountUsd: -75.0,
        kind: "REFUND",
        memo: "re_test_refund_1",
        customerKey: "cust-abc123",
      },
    ],
  };
}

describe("renderIif", () => {
  it("emits the schema headers and trailing newline", () => {
    const iif = renderIif(sampleInput());
    expect(iif).toMatch(
      /^; PennPaps QuickBooks export — PennPaps\n; Range: 2026-04-01 to 2026-04-30\n; Rows: 2\n/,
    );
    expect(iif).toContain(
      "!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO",
    );
    expect(iif).toContain("!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tMEMO");
    expect(iif).toContain("!ENDTRNS");
    expect(iif.endsWith("\n")).toBe(true);
  });

  it("emits a DEPOSIT TRNS + opposite-sign SPL for an order", () => {
    const iif = renderIif(sampleInput());
    const lines = iif.split("\n");
    // Order transaction starts after the schema block.
    const trnsIdx = lines.findIndex((l) => l.startsWith("TRNS\tORD-abc123"));
    expect(trnsIdx).toBeGreaterThanOrEqual(0);

    const trnsLine = lines[trnsIdx]!;
    expect(trnsLine).toContain("DEPOSIT");
    expect(trnsLine).toContain("Stripe Clearing");
    expect(trnsLine).toContain("250.00");

    const splLine = lines[trnsIdx + 1]!;
    expect(splLine.startsWith("SPL\t")).toBe(true);
    expect(splLine).toContain("Sales:Online Orders");
    // Sign flip for double-entry posting.
    expect(splLine).toContain("-250.00");

    expect(lines[trnsIdx + 2]).toBe("ENDTRNS");
  });

  it("emits a CREDIT MEMO TRNS + opposite-sign SPL for a refund", () => {
    const iif = renderIif(sampleInput());
    const lines = iif.split("\n");
    const trnsIdx = lines.findIndex((l) => l.startsWith("TRNS\tRFD-def456"));
    expect(trnsIdx).toBeGreaterThanOrEqual(0);

    const trnsLine = lines[trnsIdx]!;
    expect(trnsLine).toContain("CREDIT MEMO");
    expect(trnsLine).toContain("-75.00");

    const splLine = lines[trnsIdx + 1]!;
    expect(splLine).toContain("Sales Returns and Allowances");
    expect(splLine).toContain("75.00"); // sign flipped to positive
  });

  it("strips tabs and newlines from string fields", () => {
    const input = sampleInput();
    input.rows[0]!.memo = "tab\there\nand newline";
    const iif = renderIif(input);
    // The tab in the memo would otherwise break IIF column alignment.
    // Field appears in a tab-separated row; we want to assert the
    // memo column does NOT contain an embedded tab.
    const trnsLine = iif
      .split("\n")
      .find((l) => l.startsWith("TRNS\tORD-abc123"))!;
    const cols = trnsLine.split("\t");
    // 8 columns per schema (TRNS + 7 data fields).
    expect(cols).toHaveLength(8);
    expect(cols[7]).toBe("tab here and newline");
  });
});

describe("renderQboCsv", () => {
  it("emits the QBO header row first", () => {
    const csv = renderQboCsv(sampleInput());
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Date,Description,Customer,Amount,Type,Reference");
  });

  it("emits Sales Receipt for orders and Credit Memo for refunds", () => {
    const csv = renderQboCsv(sampleInput());
    const lines = csv.split("\n");
    const orderLine = lines.find((l) => l.includes("ORD-abc123"))!;
    const refundLine = lines.find((l) => l.includes("RFD-def456"))!;
    expect(orderLine).toContain("Sales Receipt");
    expect(refundLine).toContain("Credit Memo");
  });

  it("emits absolute amounts (signs are encoded via the Type column)", () => {
    const csv = renderQboCsv(sampleInput());
    const lines = csv.split("\n");
    const refundLine = lines.find((l) => l.includes("RFD-def456"))!;
    // -75 input → 75.00 in CSV; the Type=Credit Memo column gives QBO
    // the sign convention.
    expect(refundLine).toContain(",75.00,");
    expect(refundLine).not.toContain(",-75.00,");
  });

  it("escapes commas and quotes in memo strings", () => {
    const input = sampleInput();
    input.rows[0]!.memo = 'has,comma and "quote"';
    const csv = renderQboCsv(input);
    expect(csv).toContain('"has,comma and ""quote"""');
  });
});

describe("customerKeyForId", () => {
  it("returns cust-unknown for null", () => {
    expect(customerKeyForId(null)).toBe("cust-unknown");
  });

  it("emits a stable lowercase 6-char prefix", () => {
    expect(customerKeyForId("cus_ABC123XYZ")).toBe("cust-cusabc");
    // The hyphen and underscore are stripped before truncation.
    expect(customerKeyForId("3e29-ab-7d")).toBe("cust-3e29ab");
  });
});
