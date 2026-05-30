// Static guard for admin-billing-denials.tsx — denial rate + DSO dashboard.
//
// We read the source directly (no rendering), following the established
// pattern for React pages in the vitest node environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-denials.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Imports from billing-api
// ---------------------------------------------------------------------------
describe("admin-billing-denials — billing-api imports", () => {
  it("imports fetchDenialRate", () => {
    expect(SRC).toContain("fetchDenialRate");
  });

  it("imports fetchDsoByPayer", () => {
    expect(SRC).toContain("fetchDsoByPayer");
  });

  it("imports formatMoneyCents", () => {
    expect(SRC).toContain("formatMoneyCents");
  });

  it("imports formatPercent", () => {
    expect(SRC).toContain("formatPercent");
  });
});

// ---------------------------------------------------------------------------
// Root data-testid
// ---------------------------------------------------------------------------
describe("admin-billing-denials — root data-testid", () => {
  it('renders with data-testid="admin-billing-denials"', () => {
    expect(SRC).toContain('data-testid="admin-billing-denials"');
  });
});

// ---------------------------------------------------------------------------
// Page heading
// ---------------------------------------------------------------------------
describe("admin-billing-denials — page heading", () => {
  it('renders "Denials & DSO" as the h1 text', () => {
    expect(SRC).toContain("Denials & DSO");
  });
});

// ---------------------------------------------------------------------------
// Three summary tiles
// ---------------------------------------------------------------------------
describe("admin-billing-denials — summary tiles", () => {
  it("renders 'Overall denial rate' tile", () => {
    expect(SRC).toContain("Overall denial rate");
  });

  it("renders 'Decisions reached' tile", () => {
    expect(SRC).toContain("Decisions reached");
  });

  it("renders 'Total denied' tile", () => {
    expect(SRC).toContain("Total denied");
  });
});

// ---------------------------------------------------------------------------
// SummaryTile helper component
// ---------------------------------------------------------------------------
describe("admin-billing-denials — SummaryTile helper", () => {
  it("defines SummaryTile component", () => {
    expect(SRC).toContain("function SummaryTile");
  });

  it("SummaryTile accepts isLoading prop and renders skeleton", () => {
    expect(SRC).toContain("isLoading");
    expect(SRC).toContain("skeleton");
  });
});

// ---------------------------------------------------------------------------
// Two card sections — denial rate by payer and DSO by payer
// ---------------------------------------------------------------------------
describe("admin-billing-denials — card sections", () => {
  it('has "Denial rate by payer" card', () => {
    expect(SRC).toContain("Denial rate by payer");
  });

  it('has "Days-to-pay by payer" card', () => {
    expect(SRC).toContain("Days-to-pay by payer");
  });
});

// ---------------------------------------------------------------------------
// Denial-rate table column headers
// ---------------------------------------------------------------------------
describe("admin-billing-denials — denial-rate table columns", () => {
  it("has 'Payer' column", () => {
    expect(SRC).toContain("Payer");
  });

  it("has 'Decisions' column", () => {
    expect(SRC).toContain("Decisions");
  });

  it("has 'Denials' column", () => {
    expect(SRC).toContain("Denials");
  });

  it("has 'Rate' column", () => {
    expect(SRC).toContain("Rate");
  });
});

// ---------------------------------------------------------------------------
// DSO table column headers
// ---------------------------------------------------------------------------
describe("admin-billing-denials — DSO table columns", () => {
  it("has 'Paid claims' column", () => {
    expect(SRC).toContain("Paid claims");
  });

  it("has 'Total paid' column", () => {
    expect(SRC).toContain("Total paid");
  });

  it("has 'Avg days' column", () => {
    expect(SRC).toContain("Avg days");
  });
});

// ---------------------------------------------------------------------------
// Colour-coding thresholds
// ---------------------------------------------------------------------------
describe("admin-billing-denials — colour-coding thresholds", () => {
  it("colours denial rate ≥ 20% as red (#b91c1c)", () => {
    expect(SRC).toContain("#b91c1c");
    expect(SRC).toContain(">= 0.2");
  });

  it("colours denial rate ≥ 10% as amber (#b45309)", () => {
    expect(SRC).toContain("#b45309");
    expect(SRC).toContain(">= 0.1");
  });

  it("colours DSO ≥ 45 days as red (#b91c1c)", () => {
    // The 45-day threshold is used in the DSO colouring logic
    expect(SRC).toContain(">= 45");
  });

  it("colours DSO ≥ 30 days as amber (#b45309)", () => {
    expect(SRC).toContain(">= 30");
  });
});

// ---------------------------------------------------------------------------
// Empty-state messages
// ---------------------------------------------------------------------------
describe("admin-billing-denials — empty state messages", () => {
  it("shows 'No decisions in the last 90 days.' for empty denial data", () => {
    expect(SRC).toContain("No decisions in the last 90 days.");
  });

  it("shows 'No paid claims in the last 180 days.' for empty DSO data", () => {
    expect(SRC).toContain("No paid claims in the last 180 days.");
  });
});

// ---------------------------------------------------------------------------
// React-query cache keys (two separate queries)
// ---------------------------------------------------------------------------
describe("admin-billing-denials — react-query cache keys", () => {
  it("uses 'admin-billing-denial-rate' queryKey for denial-rate query", () => {
    expect(SRC).toContain('"admin-billing-denial-rate"');
  });

  it("uses 'admin-billing-dso' queryKey for DSO query", () => {
    expect(SRC).toContain('"admin-billing-dso"');
  });

  it("uses a 60-second staleTime for both queries", () => {
    expect(SRC).toContain("staleTime: 60_000");
  });
});

// ---------------------------------------------------------------------------
// Window context in the description
// ---------------------------------------------------------------------------
describe("admin-billing-denials — window context", () => {
  it("mentions 90-day window for denial rate in description", () => {
    expect(SRC).toContain("90-day");
  });

  it("mentions 180-day window for DSO in card subtitle", () => {
    expect(SRC).toContain("180-day");
  });
});
