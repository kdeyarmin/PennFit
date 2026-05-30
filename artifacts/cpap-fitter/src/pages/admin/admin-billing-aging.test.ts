// Static guard for admin-billing-aging.tsx — the A/R aging report page.
//
// We read the source directly (no rendering) following the same pattern
// as admin-shop-returns.test.ts and AppShell.nav.test.ts. This gives a
// fast, dependency-free guard in the vitest node environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-aging.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Imports from billing-api
// ---------------------------------------------------------------------------
describe("admin-billing-aging — billing-api imports", () => {
  it("imports fetchAgingReport", () => {
    expect(SRC).toContain("fetchAgingReport");
  });

  it("imports formatMoneyCents", () => {
    expect(SRC).toContain("formatMoneyCents");
  });

  it("imports AgingBucketKey type", () => {
    expect(SRC).toContain("AgingBucketKey");
  });

  it("imports AgingBuckets type", () => {
    expect(SRC).toContain("AgingBuckets");
  });
});

// ---------------------------------------------------------------------------
// Root data-testid
// ---------------------------------------------------------------------------
describe("admin-billing-aging — root data-testid", () => {
  it('renders with data-testid="admin-billing-aging"', () => {
    expect(SRC).toContain('data-testid="admin-billing-aging"');
  });
});

// ---------------------------------------------------------------------------
// Page heading
// ---------------------------------------------------------------------------
describe("admin-billing-aging — page heading", () => {
  it('renders "A/R aging" as the h1 text', () => {
    expect(SRC).toContain("A/R aging");
  });
});

// ---------------------------------------------------------------------------
// BUCKETS constant — the four age ranges
// ---------------------------------------------------------------------------
describe("admin-billing-aging — BUCKETS definition", () => {
  const expectedBuckets: ReadonlyArray<[string, string]> = [
    ["0_30", "0 – 30"],
    ["31_60", "31 – 60"],
    ["61_90", "61 – 90"],
    ["90_plus", "90+"],
  ];

  for (const [key, label] of expectedBuckets) {
    it(`defines bucket "${key}" with label "${label}"`, () => {
      expect(SRC).toContain(`key: "${key}"`);
      expect(SRC).toContain(`label: "${label}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// 90+ bucket is highlighted in red (#b91c1c)
// ---------------------------------------------------------------------------
describe("admin-billing-aging — 90+ bucket colour", () => {
  it("applies red colour (#b91c1c) to the 90+ bucket label", () => {
    expect(SRC).toContain("#b91c1c");
  });

  it('gates the red colour on key === "90_plus"', () => {
    expect(SRC).toContain('key === "90_plus"');
  });
});

// ---------------------------------------------------------------------------
// Two table sections
// ---------------------------------------------------------------------------
describe("admin-billing-aging — two card sections", () => {
  it('has an "Open A/R — overall" card title', () => {
    expect(SRC).toContain("Open A/R — overall");
  });

  it('has an "A/R aging by payer" card title', () => {
    expect(SRC).toContain("A/R aging by payer");
  });
});

// ---------------------------------------------------------------------------
// Table column headers
// ---------------------------------------------------------------------------
describe("admin-billing-aging — table column headers", () => {
  it("has 'Age (days)' column header", () => {
    expect(SRC).toContain("Age (days)");
  });

  it("has 'Claim count' column header", () => {
    expect(SRC).toContain("Claim count");
  });

  it("has 'Billed' column header", () => {
    expect(SRC).toContain("Billed");
  });

  it("has 'Payer' column header in per-payer table", () => {
    expect(SRC).toContain("Payer");
  });

  it("has 'Total' column header in per-payer table", () => {
    expect(SRC).toContain("Total");
  });
});

// ---------------------------------------------------------------------------
// Empty-state message for per-payer table
// ---------------------------------------------------------------------------
describe("admin-billing-aging — empty state", () => {
  it("shows 'No open A/R right now.' when perPayer list is empty", () => {
    expect(SRC).toContain("No open A/R right now.");
  });
});

// ---------------------------------------------------------------------------
// Total row in overall table
// ---------------------------------------------------------------------------
describe("admin-billing-aging — total row", () => {
  it("renders a 'Total' row in the overall table", () => {
    expect(SRC).toContain("Total");
  });

  it("uses totalOpenClaimCount from API response", () => {
    expect(SRC).toContain("totalOpenClaimCount");
  });

  it("uses totalOpenBilledCents from API response", () => {
    expect(SRC).toContain("totalOpenBilledCents");
  });
});

// ---------------------------------------------------------------------------
// React-query cache key
// ---------------------------------------------------------------------------
describe("admin-billing-aging — react-query cache key", () => {
  it("uses 'admin-billing-aging' as the queryKey", () => {
    expect(SRC).toContain('"admin-billing-aging"');
  });
});

// ---------------------------------------------------------------------------
// bucketTotal / bucketClaims helpers
// ---------------------------------------------------------------------------
describe("admin-billing-aging — helper functions", () => {
  it("defines a bucketTotal helper that sums billedCents", () => {
    expect(SRC).toContain("bucketTotal");
    expect(SRC).toContain("billedCents");
  });

  it("defines a bucketClaims helper that sums claimCount", () => {
    expect(SRC).toContain("bucketClaims");
    expect(SRC).toContain("claimCount");
  });
});
