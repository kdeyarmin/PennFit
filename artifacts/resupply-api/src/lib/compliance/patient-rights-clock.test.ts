import { describe, expect, it } from "vitest";

import {
  bucketizeRightsClock,
  computeDueByIso,
} from "./patient-rights-clock";

describe("bucketizeRightsClock", () => {
  const received = "2026-05-01T00:00:00.000Z";

  it("is on_time within the first 25 days", () => {
    expect(
      bucketizeRightsClock({
        receivedAt: received,
        extensionGrantedAt: null,
        status: "received",
        asOf: "2026-05-20T00:00:00.000Z",
      }),
    ).toBe("on_time");
  });

  it("is due_soon when within 5 days of the first 30-day deadline", () => {
    expect(
      bucketizeRightsClock({
        receivedAt: received,
        extensionGrantedAt: null,
        status: "in_review",
        asOf: "2026-05-28T00:00:00.000Z",
      }),
    ).toBe("due_soon");
  });

  it("flips to extension_eligible after 30 days with no extension", () => {
    expect(
      bucketizeRightsClock({
        receivedAt: received,
        extensionGrantedAt: null,
        status: "in_review",
        asOf: "2026-06-05T00:00:00.000Z",
      }),
    ).toBe("extension_eligible");
  });

  it("is on_time again after extension is granted (within window)", () => {
    expect(
      bucketizeRightsClock({
        receivedAt: received,
        extensionGrantedAt: "2026-05-29T00:00:00.000Z",
        status: "extended",
        asOf: "2026-06-10T00:00:00.000Z",
      }),
    ).toBe("on_time");
  });

  it("is extension_overdue past 60 days with extension granted", () => {
    expect(
      bucketizeRightsClock({
        receivedAt: received,
        extensionGrantedAt: "2026-05-29T00:00:00.000Z",
        status: "extended",
        asOf: "2026-07-10T00:00:00.000Z",
      }),
    ).toBe("extension_overdue");
  });

  it("is closed once the request is terminal", () => {
    for (const status of [
      "granted",
      "partially_granted",
      "denied",
      "withdrawn",
      "expired",
    ]) {
      expect(
        bucketizeRightsClock({
          receivedAt: received,
          extensionGrantedAt: null,
          status,
          asOf: "2026-09-01T00:00:00.000Z",
        }),
      ).toBe("closed");
    }
  });
});

describe("computeDueByIso", () => {
  it("returns +30d when no extension", () => {
    const due = computeDueByIso("2026-05-01T00:00:00.000Z", null);
    expect(due).toBe("2026-05-31T00:00:00.000Z");
  });

  it("returns +60d when extension granted", () => {
    const due = computeDueByIso(
      "2026-05-01T00:00:00.000Z",
      "2026-05-28T00:00:00.000Z",
    );
    expect(due).toBe("2026-06-30T00:00:00.000Z");
  });
});
