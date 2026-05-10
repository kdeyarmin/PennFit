// Pure-function tests for the dispatcher's helpers. The DB +
// vendor-fanout path is exercised by route-level tests; here we lock
// in the cadence math, the channel-order resolution, and the
// per-day script renderers so a copy-paste error can't slip into
// production unnoticed.

import { describe, expect, it } from "vitest";

import {
  isWithinCallWindow,
  nextDueCheckin,
  smsBodyForDay,
  stampFieldForDay,
  subjectForDay,
  voiceScriptForDay,
} from "./checkin-dispatcher";
import type { OnboardingDayLabel } from "@workspace/resupply-db";

const NEVER: Record<OnboardingDayLabel, Date | null> = {
  day1: null,
  day3: null,
  day7: null,
  day30: null,
  day60: null,
  day90: null,
};

describe("nextDueCheckin", () => {
  it("returns day3 once 3+ days have elapsed", () => {
    const startedAt = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-05-04T00:00:00Z");
    expect(nextDueCheckin(startedAt, NEVER, now)).toBe("day3");
  });

  it("returns null while still within day-3 window", () => {
    const startedAt = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-05-02T00:00:00Z");
    expect(nextDueCheckin(startedAt, NEVER, now)).toBeNull();
  });

  it("skips already-sent days", () => {
    const startedAt = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-06-01T00:00:00Z"); // day 31
    const sent = { ...NEVER, day3: new Date(), day7: new Date() };
    expect(nextDueCheckin(startedAt, sent, now)).toBe("day30");
  });

  it("returns day60 in the post-acclimation window", () => {
    const startedAt = new Date("2026-03-01T00:00:00Z");
    const now = new Date("2026-05-01T00:00:00Z"); // ~61 days
    const sent = {
      ...NEVER,
      day3: new Date(),
      day7: new Date(),
      day30: new Date(),
    };
    expect(nextDueCheckin(startedAt, sent, now)).toBe("day60");
  });

  it("returns null after every day has been sent", () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-12-31T00:00:00Z");
    const sent = {
      ...NEVER,
      day3: new Date(),
      day7: new Date(),
      day30: new Date(),
      day60: new Date(),
      day90: new Date(),
    };
    expect(nextDueCheckin(startedAt, sent, now)).toBeNull();
  });
});

describe("stampFieldForDay", () => {
  it.each([
    ["day1", "day1_sent_at"],
    ["day3", "day3_sent_at"],
    ["day7", "day7_sent_at"],
    ["day30", "day30_sent_at"],
    ["day60", "day60_sent_at"],
    ["day90", "day90_sent_at"],
  ] as const)("maps %s → %s", (label, field) => {
    expect(stampFieldForDay(label)).toBe(field);
  });
});

describe("rendered scripts", () => {
  it("renders an SMS body for every cadence label", () => {
    const labels: OnboardingDayLabel[] = [
      "day3",
      "day7",
      "day30",
      "day60",
      "day90",
    ];
    for (const day of labels) {
      const body = smsBodyForDay(day, "Hi Anna");
      expect(body.length).toBeGreaterThan(20);
      expect(body).toContain("PennPaps");
    }
  });

  it("renders a voice script for every cadence label", () => {
    const labels: OnboardingDayLabel[] = [
      "day3",
      "day7",
      "day30",
      "day60",
      "day90",
    ];
    for (const day of labels) {
      const script = voiceScriptForDay(day);
      expect(script.length).toBeGreaterThan(40);
      expect(script.toLowerCase()).toContain("penn paps");
    }
  });

  it("uses different subjects for the new day3 and day60 windows", () => {
    expect(subjectForDay("day3")).not.toBe(subjectForDay("day7"));
    expect(subjectForDay("day60")).not.toBe(subjectForDay("day30"));
    expect(subjectForDay("day60")).not.toBe(subjectForDay("day90"));
  });
});

describe("isWithinCallWindow", () => {
  // Anchor "now" timestamps to specific UTC instants we can reason
  // about in ET. EST is UTC-5; EDT is UTC-4. We use winter dates so
  // the offset is fixed at -5.
  it("allows a Tuesday at 10am ET", () => {
    // 2026-01-13 15:00 UTC = 10:00 EST (Tuesday)
    expect(
      isWithinCallWindow(new Date("2026-01-13T15:00:00Z")),
    ).toBe(true);
  });

  it("blocks 8am ET (before 9am)", () => {
    expect(
      isWithinCallWindow(new Date("2026-01-13T13:00:00Z")),
    ).toBe(false);
  });

  it("blocks 7pm ET on the dot", () => {
    // 19:00 ET = 24:00 UTC = next day 00:00 UTC
    expect(
      isWithinCallWindow(new Date("2026-01-14T00:00:00Z")),
    ).toBe(false);
  });

  it("allows a Saturday afternoon", () => {
    // 2026-01-17 is a Saturday — 2pm ET = 19:00 UTC
    expect(
      isWithinCallWindow(new Date("2026-01-17T19:00:00Z")),
    ).toBe(true);
  });

  it("blocks Sunday entirely", () => {
    // 2026-01-18 is a Sunday — even 11am ET should fail.
    expect(
      isWithinCallWindow(new Date("2026-01-18T16:00:00Z")),
    ).toBe(false);
  });
});
