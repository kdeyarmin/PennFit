// Tests for the returns-queue aging helpers in shop-returns-api.ts.
// Pure functions, driven directly (behavior, not source reads).

import { describe, expect, it } from "vitest";

import {
  returnActionableSince,
  waitingDays,
  type AdminReturn,
} from "./shop-returns-api";

type AgingFields = Pick<
  AdminReturn,
  "status" | "createdAt" | "shippedBackAt" | "receivedAt"
>;

const base: AgingFields = {
  status: "requested",
  createdAt: "2026-06-01T00:00:00.000Z",
  shippedBackAt: null,
  receivedAt: null,
};

describe("returnActionableSince", () => {
  it("uses createdAt for a 'requested' return", () => {
    expect(returnActionableSince({ ...base, status: "requested" })).toBe(
      base.createdAt,
    );
  });

  it("uses shippedBackAt for a 'shipped_back' return", () => {
    expect(
      returnActionableSince({
        ...base,
        status: "shipped_back",
        shippedBackAt: "2026-06-05T00:00:00.000Z",
      }),
    ).toBe("2026-06-05T00:00:00.000Z");
  });

  it("uses receivedAt for a 'received' return", () => {
    expect(
      returnActionableSince({
        ...base,
        status: "received",
        receivedAt: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe("2026-06-08T00:00:00.000Z");
  });

  it("falls back to createdAt when the transition timestamp is missing", () => {
    expect(returnActionableSince({ ...base, status: "shipped_back" })).toBe(
      base.createdAt,
    );
    expect(returnActionableSince({ ...base, status: "received" })).toBe(
      base.createdAt,
    );
  });

  it("returns null for 'approved' (waiting on the customer, not the admin)", () => {
    expect(returnActionableSince({ ...base, status: "approved" })).toBeNull();
  });

  it("returns null for terminal states", () => {
    for (const status of [
      "refunded",
      "replaced",
      "rejected",
      "closed",
    ] as const) {
      expect(returnActionableSince({ ...base, status })).toBeNull();
    }
  });
});

describe("waitingDays", () => {
  const now = new Date("2026-06-10T00:00:00.000Z").getTime();

  it("floors to whole days", () => {
    expect(waitingDays("2026-06-08T12:00:00.000Z", now)).toBe(1);
    expect(waitingDays("2026-06-03T00:00:00.000Z", now)).toBe(7);
  });

  it("returns 0 for the same instant", () => {
    expect(waitingDays("2026-06-10T00:00:00.000Z", now)).toBe(0);
  });

  it("never goes negative for a future timestamp", () => {
    expect(waitingDays("2026-06-20T00:00:00.000Z", now)).toBe(0);
  });

  it("returns 0 for an unparseable timestamp rather than NaN", () => {
    expect(waitingDays("not-a-date", now)).toBe(0);
  });
});
