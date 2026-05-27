// Tests for pages/admin/admin-billing-eligibility.tsx
//
// PR change (a11y): the status-filter <select> element was given an
// aria-label="Status" attribute so screen-reader users know which
// filter control they are interacting with.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-eligibility.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-label on the status filter
// ---------------------------------------------------------------------------

describe("admin-billing-eligibility — a11y: status filter aria-label", () => {
  it("status filter select has aria-label='Status'", () => {
    expect(SRC).toContain('aria-label="Status"');
  });

  it("status filter select retains data-testid='eligibility-status-filter'", () => {
    expect(SRC).toContain('data-testid="eligibility-status-filter"');
  });

  it("aria-label appears near the data-testid (same element)", () => {
    // Confirm both are within 200 chars of each other to verify they
    // belong to the same <select> element rather than separate ones.
    const ariaIdx = SRC.indexOf('aria-label="Status"');
    const testidIdx = SRC.indexOf('data-testid="eligibility-status-filter"');
    expect(Math.abs(ariaIdx - testidIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Regression: page exports and core behaviour retained
// ---------------------------------------------------------------------------

describe("admin-billing-eligibility — regression", () => {
  it("still exports AdminBillingEligibilityPage", () => {
    expect(SRC).toContain("export function AdminBillingEligibilityPage");
  });

  it("still uses EligibilityStatus for the filter type", () => {
    expect(SRC).toContain("EligibilityStatus");
  });
});