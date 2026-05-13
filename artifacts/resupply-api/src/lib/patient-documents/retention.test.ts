// Pin the retention catalog so a future refactor can't quietly
// shorten the horizons.

import { describe, it, expect } from "vitest";

import {
  bucketRetention,
  computeRetentionUntilAt,
  retentionYearsForDocumentType,
} from "./retention";

describe("retentionYearsForDocumentType", () => {
  it("matches the catalog comment-block defaults", () => {
    expect(retentionYearsForDocumentType("insurance_card")).toBe(2);
    expect(retentionYearsForDocumentType("prescription")).toBe(7);
    expect(retentionYearsForDocumentType("sleep_study")).toBe(10);
    expect(retentionYearsForDocumentType("diagnostic_report")).toBe(10);
    expect(retentionYearsForDocumentType("referral")).toBe(6);
    expect(retentionYearsForDocumentType("other")).toBe(6);
  });

  it("defaults unknown types to the 6-year HIPAA floor", () => {
    expect(retentionYearsForDocumentType("not_in_catalog")).toBe(6);
  });
});

describe("computeRetentionUntilAt", () => {
  it("adds the right number of years (insurance_card: +2)", () => {
    const r = computeRetentionUntilAt({
      createdAt: new Date("2020-03-15T00:00:00Z"),
      documentType: "insurance_card",
    });
    expect(r.toISOString().slice(0, 10)).toBe("2022-03-15");
  });

  it("handles leap-year boundary (Feb 29 → Mar 1)", () => {
    const r = computeRetentionUntilAt({
      createdAt: new Date("2020-02-29T00:00:00Z"),
      documentType: "prescription",
    });
    // 2020-02-29 + 7y = 2027 (non-leap); JS rolls to 2027-03-01.
    expect(r.toISOString().slice(0, 10)).toBe("2027-03-01");
  });
});

describe("bucketRetention", () => {
  const asOfDate = new Date("2026-05-12T12:00:00Z");

  it("legal_hold overrides every other field", () => {
    expect(
      bucketRetention({
        retentionUntilAt: "2010-01-01T00:00:00Z",
        retentionMarkedAt: "2020-01-01T00:00:00Z",
        destroyedAt: null,
        legalHold: true,
        asOfDate,
      }),
    ).toBe("legal_hold");
  });

  it("destroyed dominates legal_hold? — destroyed wins (row is dead)", () => {
    // The row's bytes are gone; "legal_hold" no longer protects
    // anything — we surface the destroyed terminal state so the
    // admin UI doesn't pretend the document is still recoverable.
    expect(
      bucketRetention({
        retentionUntilAt: null,
        retentionMarkedAt: null,
        destroyedAt: "2025-01-01T00:00:00Z",
        legalHold: true,
        asOfDate,
      }),
    ).toBe("destroyed");
  });

  it("null retention_until_at => active", () => {
    expect(
      bucketRetention({
        retentionUntilAt: null,
        retentionMarkedAt: null,
        destroyedAt: null,
        legalHold: false,
        asOfDate,
      }),
    ).toBe("active");
  });

  it("past retention_until_at => due_now", () => {
    expect(
      bucketRetention({
        retentionUntilAt: "2026-05-01T00:00:00Z",
        retentionMarkedAt: null,
        destroyedAt: null,
        legalHold: false,
        asOfDate,
      }),
    ).toBe("due_now");
  });

  it("within 30 days => due_soon", () => {
    expect(
      bucketRetention({
        retentionUntilAt: "2026-05-20T00:00:00Z",
        retentionMarkedAt: null,
        destroyedAt: null,
        legalHold: false,
        asOfDate,
      }),
    ).toBe("due_soon");
  });

  it("retentionMarkedAt set => marked (awaiting destruction)", () => {
    expect(
      bucketRetention({
        retentionUntilAt: "2026-05-01T00:00:00Z",
        retentionMarkedAt: "2026-05-02T00:00:00Z",
        destroyedAt: null,
        legalHold: false,
        asOfDate,
      }),
    ).toBe("marked");
  });
});
