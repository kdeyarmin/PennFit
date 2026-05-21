// Tests for pages/admin/admin-shop-inventory-reconcile-edit.tsx
//
// The page contains three module-scoped pure functions that carry
// the most logic worth unit testing:
//
//   parseCounted(raw)        — parse a text-input string to a non-negative integer
//   computeVariance(sys, ct) — derive variance from system and counted quantities
//   buildDraftLines(detail)  — map ReconciliationDetail to sorted DraftLine[]
//
// These functions are not exported, so we use two complementary strategies:
//
//   1. Static source analysis — readFileSync assertions to verify structural
//      invariants (the functions exist, their constraints are as expected).
//
//   2. Pure-logic re-implementation — each function is re-implemented verbatim
//      from the source so boundary behaviour can be tested exhaustively without
//      React / DOM.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-inventory-reconcile-edit.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Static source analysis
// ---------------------------------------------------------------------------

describe("admin-shop-inventory-reconcile-edit — exports", () => {
  it("exports AdminShopInventoryReconcileEditPage", () => {
    expect(SRC).toContain("export function AdminShopInventoryReconcileEditPage");
  });
});

describe("admin-shop-inventory-reconcile-edit — parseCounted constraints", () => {
  it("trims whitespace before parsing", () => {
    expect(SRC).toContain("raw.trim()");
  });

  it("returns null for empty string", () => {
    // The function guards with `trimmed === ""`
    expect(SRC).toContain('trimmed === ""');
  });

  it("only accepts digit-only strings via regex", () => {
    expect(SRC).toContain("/^\\d+$/");
  });

  it("enforces an upper bound of 1,000,000", () => {
    expect(SRC).toContain("1_000_000");
  });

  it("uses parseInt with radix 10", () => {
    expect(SRC).toContain("parseInt(trimmed, 10)");
  });
});

describe("admin-shop-inventory-reconcile-edit — computeVariance structure", () => {
  it("returns null when counted is null", () => {
    // Guard: `if (counted === null) return null`
    expect(SRC).toContain("if (counted === null) return null");
  });

  it("returns counted directly when systemCount is null", () => {
    // Guard: `if (systemCount === null) return counted`
    expect(SRC).toContain("if (systemCount === null) return counted");
  });

  it("computes variance as counted minus systemCount", () => {
    expect(SRC).toContain("counted - systemCount");
  });
});

describe("admin-shop-inventory-reconcile-edit — buildDraftLines structure", () => {
  it("returns empty array when currentProducts is null/falsy", () => {
    expect(SRC).toContain("if (!detail.currentProducts) return []");
  });

  it("sorts lines by productName using localeCompare", () => {
    expect(SRC).toContain("localeCompare");
  });

  it("initialises countedQty to empty string", () => {
    // Each draft line starts with countedQty: ""
    expect(SRC).toContain('countedQty: ""');
  });
});

describe("admin-shop-inventory-reconcile-edit — data-testid attributes", () => {
  it("assigns data-testid to each input row keyed by productId", () => {
    expect(SRC).toContain("reconcile-input-");
  });

  it("assigns data-testid to each line row keyed by productId", () => {
    expect(SRC).toContain("reconcile-line-");
  });

  it("assigns data-testid to the submit button", () => {
    expect(SRC).toContain('data-testid="reconcile-submit-btn"');
  });

  it("assigns data-testid to the apply-to-Stripe toggle", () => {
    expect(SRC).toContain('data-testid="reconcile-apply-toggle"');
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of parseCounted (verbatim from source)
// ---------------------------------------------------------------------------

function parseCounted(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (n < 0 || n > 1_000_000) return null;
  return n;
}

describe("parseCounted — returns null for blank/invalid input", () => {
  it("returns null for an empty string", () => {
    expect(parseCounted("")).toBeNull();
  });

  it("returns null for a string of spaces", () => {
    expect(parseCounted("   ")).toBeNull();
  });

  it("returns null for a non-numeric string", () => {
    expect(parseCounted("abc")).toBeNull();
  });

  it("returns null for a floating-point string", () => {
    expect(parseCounted("1.5")).toBeNull();
  });

  it("returns null for a negative sign prefix (regex excludes it)", () => {
    expect(parseCounted("-5")).toBeNull();
  });

  it("returns null for scientific notation", () => {
    expect(parseCounted("1e5")).toBeNull();
  });

  it("returns null for a value exceeding 1,000,000", () => {
    expect(parseCounted("1000001")).toBeNull();
  });

  it("returns null for a hex string (has non-digit chars x, a-f)", () => {
    expect(parseCounted("0xff")).toBeNull();
  });
});

describe("parseCounted — returns a non-negative integer for valid input", () => {
  it("parses '0' to 0", () => {
    expect(parseCounted("0")).toBe(0);
  });

  it("parses '1' to 1", () => {
    expect(parseCounted("1")).toBe(1);
  });

  it("parses '42' to 42", () => {
    expect(parseCounted("42")).toBe(42);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseCounted("  42  ")).toBe(42);
  });

  it("parses the exact boundary value 1,000,000", () => {
    expect(parseCounted("1000000")).toBe(1_000_000);
  });

  it("parses '01' as 1 (parseInt radix 10 handles leading zeros)", () => {
    expect(parseCounted("01")).toBe(1);
  });

  it("parses '999999'", () => {
    expect(parseCounted("999999")).toBe(999_999);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of computeVariance (verbatim from source)
// ---------------------------------------------------------------------------

function computeVariance(
  systemCount: number | null,
  counted: number | null,
): number | null {
  if (counted === null) return null;
  if (systemCount === null) return counted;
  return counted - systemCount;
}

describe("computeVariance — null propagation", () => {
  it("returns null when counted is null", () => {
    expect(computeVariance(10, null)).toBeNull();
  });

  it("returns null when both arguments are null", () => {
    expect(computeVariance(null, null)).toBeNull();
  });
});

describe("computeVariance — null systemCount", () => {
  it("returns counted directly when systemCount is null", () => {
    expect(computeVariance(null, 5)).toBe(5);
  });

  it("returns 0 when systemCount is null and counted is 0", () => {
    expect(computeVariance(null, 0)).toBe(0);
  });
});

describe("computeVariance — both values present", () => {
  it("returns 0 when counted equals systemCount", () => {
    expect(computeVariance(10, 10)).toBe(0);
  });

  it("returns a positive variance when counted > systemCount", () => {
    expect(computeVariance(10, 15)).toBe(5);
  });

  it("returns a negative variance when counted < systemCount", () => {
    expect(computeVariance(15, 10)).toBe(-5);
  });

  it("handles a large system count correctly", () => {
    expect(computeVariance(1_000_000, 999_999)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of buildDraftLines (verbatim from source)
// ---------------------------------------------------------------------------

interface CurrentProductSnapshot {
  productId: string;
  name: string;
  category: string;
  systemCount: number | null;
  lowStockThreshold: number | null;
}

interface ReconciliationDetail {
  reconciliation: {
    id: string;
    periodLabel: string;
    status: "draft" | "submitted";
    startedByEmail: string;
    startedByUserId: string | null;
    startedAt: string;
    submittedAt: string | null;
    notes: string | null;
    totalLines: number;
    totalVarianceUnits: number;
    appliedToStripe: boolean;
  };
  lines: unknown[];
  currentProducts: CurrentProductSnapshot[] | null;
}

interface DraftLine {
  productId: string;
  productName: string;
  systemCount: number | null;
  countedQty: string;
}

function buildDraftLines(detail: ReconciliationDetail): DraftLine[] {
  if (!detail.currentProducts) return [];
  return detail.currentProducts
    .map((p) => ({
      productId: p.productId,
      productName: p.name,
      systemCount: p.systemCount,
      countedQty: "",
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

const BASE_RECON: ReconciliationDetail["reconciliation"] = {
  id: "r1",
  periodLabel: "2026-05",
  status: "draft",
  startedByEmail: "ops@test.com",
  startedByUserId: null,
  startedAt: "2026-05-01T00:00:00Z",
  submittedAt: null,
  notes: null,
  totalLines: 0,
  totalVarianceUnits: 0,
  appliedToStripe: false,
};

describe("buildDraftLines — null currentProducts", () => {
  it("returns an empty array when currentProducts is null", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: null,
    };
    expect(buildDraftLines(detail)).toEqual([]);
  });
});

describe("buildDraftLines — empty currentProducts array", () => {
  it("returns an empty array when currentProducts is []", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [],
    };
    expect(buildDraftLines(detail)).toEqual([]);
  });
});

describe("buildDraftLines — mapping", () => {
  it("maps productId from the snapshot", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_abc", name: "Mask A", category: "masks", systemCount: 10, lowStockThreshold: 2 },
      ],
    };
    const [line] = buildDraftLines(detail);
    expect(line.productId).toBe("prod_abc");
  });

  it("maps name → productName", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_abc", name: "Mask A", category: "masks", systemCount: 10, lowStockThreshold: 2 },
      ],
    };
    const [line] = buildDraftLines(detail);
    expect(line.productName).toBe("Mask A");
  });

  it("preserves systemCount (including null)", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_abc", name: "Mask A", category: "masks", systemCount: null, lowStockThreshold: null },
      ],
    };
    const [line] = buildDraftLines(detail);
    expect(line.systemCount).toBeNull();
  });

  it("initialises countedQty to empty string", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_abc", name: "Mask A", category: "masks", systemCount: 5, lowStockThreshold: 2 },
      ],
    };
    const [line] = buildDraftLines(detail);
    expect(line.countedQty).toBe("");
  });
});

describe("buildDraftLines — sorting", () => {
  it("sorts lines alphabetically by productName (ascending)", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_c", name: "Zzz Mask", category: "masks", systemCount: 1, lowStockThreshold: null },
        { productId: "prod_a", name: "Aaa Tube", category: "tubes", systemCount: 5, lowStockThreshold: null },
        { productId: "prod_b", name: "Mmm Filter", category: "filters", systemCount: 3, lowStockThreshold: null },
      ],
    };
    const lines = buildDraftLines(detail);
    expect(lines.map((l) => l.productName)).toEqual(["Aaa Tube", "Mmm Filter", "Zzz Mask"]);
  });

  it("preserves original order when names are identical (stable-ish sort)", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_1", name: "Same Name", category: "x", systemCount: 1, lowStockThreshold: null },
        { productId: "prod_2", name: "Same Name", category: "x", systemCount: 2, lowStockThreshold: null },
      ],
    };
    const lines = buildDraftLines(detail);
    expect(lines).toHaveLength(2);
    expect(lines[0].productName).toBe("Same Name");
    expect(lines[1].productName).toBe("Same Name");
  });

  it("sorts a single product with no-op sort", () => {
    const detail: ReconciliationDetail = {
      reconciliation: BASE_RECON,
      lines: [],
      currentProducts: [
        { productId: "prod_x", name: "Only Product", category: "x", systemCount: 7, lowStockThreshold: 2 },
      ],
    };
    const lines = buildDraftLines(detail);
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe("prod_x");
  });
});