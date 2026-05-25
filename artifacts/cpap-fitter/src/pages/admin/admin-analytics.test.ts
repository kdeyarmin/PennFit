// Tests for pages/admin/admin-analytics.tsx
//
// PR change: the `if (data.unavailable)` branch was removed from
// ProductivityBody. The audit-log retirement notice UI is gone; the
// component now always renders either the empty-state message or the
// productivity table — never the "no longer tracked" banner.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-analytics.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// ProductivityBody — `unavailable` branch removed
// ---------------------------------------------------------------------------

describe("admin-analytics ProductivityBody — unavailable branch removed", () => {
  it("does not render a data-testid='csr-productivity-unavailable' element", () => {
    expect(SRC).not.toContain("csr-productivity-unavailable");
  });

  it("does not check data.unavailable in ProductivityBody", () => {
    // The branch was `if (data.unavailable) { return … }`. Neither the
    // property access nor the conditional should appear in the function.
    const fnStart = SRC.indexOf("function ProductivityBody(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).not.toContain("data.unavailable");
    expect(fnBody).not.toContain(".unavailable");
  });

  it("does not render the 'no longer tracked' retirement notice text", () => {
    expect(SRC).not.toContain(
      "Per-operator productivity is no longer tracked",
    );
  });

  it("does not mention the 'audit log was retired' in ProductivityBody", () => {
    expect(SRC).not.toContain("audit log was retired");
  });
});

// ---------------------------------------------------------------------------
// ProductivityBody — correct branches still present
// ---------------------------------------------------------------------------

describe("admin-analytics ProductivityBody — retained branches", () => {
  it("still renders an empty-state message when rows.length === 0", () => {
    expect(SRC).toContain("data.rows.length === 0");
  });

  it("still renders the productivity table rows when data is available", () => {
    expect(SRC).toContain("data.rows.map(");
  });

  it("still exports AdminAnalyticsPage", () => {
    expect(SRC).toContain("export function AdminAnalyticsPage");
  });

  it("still imports fetchCsrProductivity", () => {
    expect(SRC).toContain("fetchCsrProductivity");
  });
});

// ---------------------------------------------------------------------------
// Regression: page-level wiring
// ---------------------------------------------------------------------------

describe("admin-analytics — page-level wiring", () => {
  it("contains the ProductivityPanel component", () => {
    expect(SRC).toContain("function ProductivityPanel(");
  });

  it("contains the ProductivityBody component", () => {
    expect(SRC).toContain("function ProductivityBody(");
  });

  it("still imports from the analytics-api lib", () => {
    expect(SRC).toContain("@/lib/admin/analytics-api");
  });
});