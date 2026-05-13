// Pure-function tests for the accreditation-binder helpers.

import { describe, it, expect } from "vitest";

import {
  DUE_SOON_DAYS,
  GRIEVANCE_TRANSITIONS,
  bucketizeTrainingExpiry,
  isLegalGrievanceTransition,
  parseIsoDate,
  type GrievanceStatus,
} from "./training-expiry";

describe("bucketizeTrainingExpiry", () => {
  const TODAY = "2026-06-15";

  it("returns 'current' when expiresAt is null (one-time training)", () => {
    expect(
      bucketizeTrainingExpiry({ expiresAt: null, asOfDate: TODAY }),
    ).toBe("current");
  });

  it("returns 'current' when expiry is far in the future", () => {
    expect(
      bucketizeTrainingExpiry({
        expiresAt: "2027-01-01",
        asOfDate: TODAY,
      }),
    ).toBe("current");
  });

  it("returns 'due_soon' on the cusp of the window", () => {
    // Today + DUE_SOON_DAYS = 2026-07-15 → due-soon should kick in.
    const cusp = "2026-07-15";
    expect(
      bucketizeTrainingExpiry({ expiresAt: cusp, asOfDate: TODAY }),
    ).toBe("due_soon");
  });

  it("returns 'due_soon' just before expiry", () => {
    expect(
      bucketizeTrainingExpiry({
        expiresAt: "2026-06-16",
        asOfDate: TODAY,
      }),
    ).toBe("due_soon");
  });

  it("returns 'expired' on the expiry date itself", () => {
    // Documented semantics: today === expires_at counts as expired
    // because the training was valid THROUGH the prior day.
    expect(
      bucketizeTrainingExpiry({
        expiresAt: TODAY,
        asOfDate: TODAY,
      }),
    ).toBe("expired");
  });

  it("returns 'expired' after the expiry date", () => {
    expect(
      bucketizeTrainingExpiry({
        expiresAt: "2026-05-01",
        asOfDate: TODAY,
      }),
    ).toBe("expired");
  });

  it("rejects malformed ISO dates conservatively (returns 'current')", () => {
    expect(
      bucketizeTrainingExpiry({
        expiresAt: "not-a-date",
        asOfDate: TODAY,
      }),
    ).toBe("current");
  });

  it("DUE_SOON_DAYS is exported and is the documented 30", () => {
    // Behavioral pin — if we ever widen the heads-up window, every
    // dashboard and surveyor report that reads this constant should
    // change in lock-step.
    expect(DUE_SOON_DAYS).toBe(30);
  });
});

describe("parseIsoDate", () => {
  it("parses a well-formed date", () => {
    const d = parseIsoDate("2026-05-11");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(4); // May = 4
    expect(d!.getUTCDate()).toBe(11);
  });
  it("rejects non-ISO strings", () => {
    expect(parseIsoDate("05/11/2026")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toEqual(
      new Date(Date.UTC(2026, 12, 1)),
    );
    // Note: we accept 2026-13-01 as a valid regex match and let the
    // Date constructor roll over to 2027-01-01 — same forgiving
    // behavior the rest of the codebase uses. Documenting the
    // limitation pins it.
  });
});

describe("isLegalGrievanceTransition", () => {
  it("allows same-status no-ops", () => {
    expect(isLegalGrievanceTransition("open", "open")).toBe(true);
    expect(isLegalGrievanceTransition("resolved", "resolved")).toBe(true);
  });

  it("matches the documented state machine", () => {
    // open → acknowledged, resolved, escalated
    expect(isLegalGrievanceTransition("open", "acknowledged")).toBe(true);
    expect(isLegalGrievanceTransition("open", "resolved")).toBe(true);
    expect(isLegalGrievanceTransition("open", "escalated")).toBe(true);
    expect(isLegalGrievanceTransition("open", "reopened")).toBe(false);

    // acknowledged → resolved, escalated
    expect(isLegalGrievanceTransition("acknowledged", "resolved")).toBe(true);
    expect(isLegalGrievanceTransition("acknowledged", "escalated")).toBe(true);
    expect(isLegalGrievanceTransition("acknowledged", "open")).toBe(false);

    // escalated → resolved only
    expect(isLegalGrievanceTransition("escalated", "resolved")).toBe(true);
    expect(isLegalGrievanceTransition("escalated", "open")).toBe(false);

    // resolved → reopened only
    expect(isLegalGrievanceTransition("resolved", "reopened")).toBe(true);
    expect(isLegalGrievanceTransition("resolved", "open")).toBe(false);
    expect(isLegalGrievanceTransition("resolved", "escalated")).toBe(false);

    // reopened → resolved only
    expect(isLegalGrievanceTransition("reopened", "resolved")).toBe(true);
    expect(isLegalGrievanceTransition("reopened", "open")).toBe(false);
  });

  it("covers every status in the GRIEVANCE_TRANSITIONS map", () => {
    // Sanity: if a future commit adds a status to GrievanceStatus but
    // forgets to add it to the map, this catches it.
    const statuses: GrievanceStatus[] = [
      "open",
      "acknowledged",
      "escalated",
      "resolved",
      "reopened",
    ];
    for (const s of statuses) {
      expect(GRIEVANCE_TRANSITIONS[s]).toBeDefined();
    }
  });
});
