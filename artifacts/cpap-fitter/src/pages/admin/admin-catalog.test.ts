// Source-level contract tests for the catalog page.
//
// The load-bearing decision on this page is that stock is recorded as a
// MOVEMENT, never typed in as a new total. That is what keeps the ledger
// and the on-hand number in agreement, so it is worth pinning against a
// well-meaning future "just let them edit the number" refactor.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-catalog.tsx"), "utf8");

describe("admin catalog page", () => {
  it("scopes its styling to the admin theme root", () => {
    // Admin tokens live under `.admin-root`; a page that forgets the class
    // renders with the storefront's palette (see admin.scope.test.ts).
    expect(SRC).toContain('className="admin-root');
  });

  it("moves stock through adjustStock, never a direct stock write", () => {
    expect(SRC).toContain("adjustStock(");
    // saveProduct may set an OPENING balance on a new SKU, but must never
    // be handed a stockCount for an existing one.
    expect(SRC).not.toMatch(/saveProduct\([^)]*stockCount/s);
  });

  it("converts a physical count into a delta rather than an absolute set", () => {
    // A count is the one input that is a total, not a movement. It has to
    // be rebased against the current number or the ledger stops adding up.
    expect(SRC).toContain('reason === "count"');
    expect(SRC).toContain("qty - (product.stockCount ?? 0)");
  });

  it("refuses a zero-delta movement before calling the API", () => {
    // The RPC rejects a zero delta too; catching it here gives the operator
    // a sentence instead of a 500.
    expect(SRC).toContain("delta === 0");
  });

  it("requires a reason for every movement", () => {
    for (const reason of ["receipt", "return", "count", "adjustment"]) {
      expect(SRC).toContain(`"${reason}"`);
    }
  });

  it("lets a SKU be created without stock tracking", () => {
    // Untracked is a deliberate choice — an unchecked box must send null,
    // not 0, or the SKU starts warning at the default threshold.
    expect(SRC).toContain("trackStock ?");
    expect(SRC).toContain("openingStock");
  });

  it("surfaces low stock as its own filter and badge", () => {
    expect(SRC).toContain("lowStockOnly");
    expect(SRC).toContain("catalog-low-badge-");
  });
});
