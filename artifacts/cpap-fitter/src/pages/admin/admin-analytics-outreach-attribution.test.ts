// Structural guards for the outreach-attribution admin page (source-
// string assertions, no DOM — same pattern as rules.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-analytics-outreach-attribution.tsx"),
  "utf8",
);

describe("admin-analytics-outreach-attribution page", () => {
  it("wraps its outer div in admin-root (CLAUDE.md scoping rule)", () => {
    expect(SRC).toContain('className="admin-root');
  });

  it("exports the AdminAnalyticsOutreachAttributionPage component", () => {
    expect(SRC).toContain(
      "export function AdminAnalyticsOutreachAttributionPage",
    );
  });

  it("fetches through the outreach-attribution api helper", () => {
    expect(SRC).toContain("fetchOutreachAttribution");
    expect(SRC).toContain("@/lib/admin/analytics-outreach-attribution-api");
  });

  it("offers a CSV export link", () => {
    expect(SRC).toContain("outreachAttributionCsvUrl");
  });

  it("renders contacted / converted / conversion-rate metrics", () => {
    expect(SRC).toContain("Conversion rate");
    expect(SRC).toContain("BySourceTable");
  });
});
