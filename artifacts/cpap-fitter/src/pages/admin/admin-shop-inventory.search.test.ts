// Static guards for the catalog search added to admin-shop-inventory.tsx.
//
// The cpap-fitter vitest env is "node" (no jsdom/RTL), so — like
// AppShell.nav.test.ts — we read the source file and assert the search
// wiring is present: the input, the client-side filter, the visible-set
// scoping, and the selection reset that keeps bulk updates from touching
// off-screen rows.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-inventory.tsx"),
  "utf8",
);

describe("admin-shop-inventory — catalog search", () => {
  it("renders a search input with a stable test id and aria-label", () => {
    expect(SRC).toContain('data-testid="inventory-search"');
    expect(SRC).toContain('aria-label="Search inventory"');
  });

  it("derives filteredProducts by name, SKU id, and category", () => {
    expect(SRC).toContain("const filteredProducts = useMemo(");
    expect(SRC).toContain("p.name.toLowerCase().includes(normalizedQuery)");
    expect(SRC).toContain("p.id.toLowerCase().includes(normalizedQuery)");
    expect(SRC).toContain(
      '(p.category ?? "").toLowerCase().includes(normalizedQuery)',
    );
  });

  it("renders rows from the filtered set, not the raw product list", () => {
    expect(SRC).toContain("{filteredProducts.map((p) => {");
    expect(SRC).not.toContain("{data.products.map((p) => {");
  });

  it("scopes the select-all / bulk visible set to the filtered rows", () => {
    expect(SRC).toContain("filteredProducts.map((p) => p.id)");
  });

  it("resets selection when the query changes (no bulk on hidden rows)", () => {
    expect(SRC).toContain("function onQueryChange(next: string)");
    const idx = SRC.indexOf("function onQueryChange(next: string)");
    const block = SRC.slice(idx, idx + 160);
    expect(block).toContain("setSelectedIds(new Set())");
  });

  it("shows an explicit no-matches row when the filter empties the table", () => {
    expect(SRC).toContain('data-testid="inventory-no-matches"');
    expect(SRC).toContain("No SKUs match");
  });

  it("shows an 'X of Y SKUs' count next to the search", () => {
    expect(SRC).toContain('data-testid="inventory-count"');
    expect(SRC).toContain("of ${data.products.length} SKUs");
  });
});
