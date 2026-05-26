// Tests for pages/admin/admin-analytics.tsx
//
// CSR productivity is derived from the retired `audit_log` table, so
// ProductivityBody short-circuits on `data.unavailable` and renders a
// "no longer tracked" notice (CLAUDE.md hard rule: the four audit_log
// readers surface a degraded contract instead of fabricating data).
// These tests pin that notice so it isn't accidentally dropped.
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

describe("admin-analytics ProductivityBody — unavailable branch present", () => {
  it("renders a data-testid='csr-productivity-unavailable' element", () => {
    expect(SRC).toContain("csr-productivity-unavailable");
  });

  it("checks data.unavailable in ProductivityBody", () => {
    const fnStart = SRC.indexOf("function ProductivityBody(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("data.unavailable");
  });

  it("renders the 'no longer tracked' retirement notice text", () => {
    expect(SRC).toContain(
      "Per-operator productivity is no longer tracked",
    );
  });

  it("mentions that the 'audit log was retired'", () => {
    expect(SRC).toContain("audit log was retired");
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