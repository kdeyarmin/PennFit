// Structural guards for the revenue-by-source admin page (source-string
// assertions, no DOM — same pattern as rules.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-analytics-revenue-by-source.tsx"),
  "utf8",
);

describe("admin-analytics-revenue-by-source page", () => {
  it("wraps its outer div in admin-root (CLAUDE.md scoping rule)", () => {
    expect(SRC).toContain('className="admin-root');
  });

  it("exports the AdminAnalyticsRevenueBySourcePage component", () => {
    expect(SRC).toContain("export function AdminAnalyticsRevenueBySourcePage");
  });

  it("fetches through the revenue-by-source api helper", () => {
    expect(SRC).toContain("fetchRevenueBySource");
    expect(SRC).toContain("@/lib/admin/analytics-revenue-by-source-api");
  });

  it("offers a CSV export link", () => {
    expect(SRC).toContain("revenueBySourceCsvUrl");
  });

  it("renders order volume + cash revenue per source", () => {
    expect(SRC).toContain("Cash revenue");
    expect(SRC).toContain("BySourceTable");
  });
});
