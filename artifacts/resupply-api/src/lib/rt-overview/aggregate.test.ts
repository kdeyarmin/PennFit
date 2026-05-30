import { describe, it, expect } from "vitest";

import {
  aggregatePatientWindow,
  labelForTriggerKind,
  summarizeOverview,
  type TherapyNightInput,
} from "./aggregate";

const ASOF = "2026-05-17";

function night(
  date: string,
  usage: number | null,
  ahi: string | null,
  leak: string | null,
): TherapyNightInput {
  return {
    night_date: date,
    usage_minutes: usage,
    ahi,
    leak_rate_l_min: leak,
  };
}

describe("aggregatePatientWindow", () => {
  it("returns null fields when the patient has no nights at all", () => {
    const r = aggregatePatientWindow([], ASOF, 7);
    expect(r).toEqual({
      nightsInWindow: 0,
      lastNightDate: null,
      staleDays: null,
      ahiAvg: null,
      leakAvg: null,
      usageMinutesAvg: null,
    });
  });

  it("averages over the inclusive window only", () => {
    const nights = [
      night("2026-05-09", 300, "2.0", "10"), // outside (8 days ago)
      night("2026-05-10", 400, "3.0", "12"), // outside (7 days ago)
      night("2026-05-11", 420, "4.0", "14"), // in window
      night("2026-05-17", 480, "5.0", "16"), // in window (today)
    ];
    const r = aggregatePatientWindow(nights, ASOF, 7);
    expect(r.nightsInWindow).toBe(2);
    // average of 4 and 5 = 4.5 → rounded to one decimal
    expect(r.ahiAvg).toBe(4.5);
    // average of 14 and 16 = 15
    expect(r.leakAvg).toBe(15);
    // average of 420 and 480 = 450
    expect(r.usageMinutesAvg).toBe(450);
    // lastNightDate considers ALL nights, not just the window
    expect(r.lastNightDate).toBe("2026-05-17");
    expect(r.staleDays).toBe(0);
  });

  it("counts nights with missing metrics but excludes them from the average", () => {
    const nights = [
      night("2026-05-15", 300, null, "10"),
      night("2026-05-16", 400, "3.0", null),
      night("2026-05-17", 500, "5.0", "20"),
    ];
    const r = aggregatePatientWindow(nights, ASOF, 7);
    expect(r.nightsInWindow).toBe(3);
    // ahi: 3.0 + 5.0 = 8 / 2 = 4
    expect(r.ahiAvg).toBe(4);
    // leak: 10 + 20 = 30 / 2 = 15
    expect(r.leakAvg).toBe(15);
    expect(r.usageMinutesAvg).toBe(400);
  });

  it("staleDays reflects the most-recent night even if it's outside the window", () => {
    const nights = [night("2026-04-01", 300, "2.0", "10")];
    const r = aggregatePatientWindow(nights, ASOF, 7);
    expect(r.nightsInWindow).toBe(0);
    expect(r.lastNightDate).toBe("2026-04-01");
    expect(r.staleDays).toBe(46);
    expect(r.ahiAvg).toBeNull();
  });

  it("ignores rows with unparseable dates", () => {
    const nights = [
      {
        night_date: "not-a-date",
        usage_minutes: 300,
        ahi: "5",
        leak_rate_l_min: "20",
      },
      night("2026-05-17", 400, "3.0", "12"),
    ];
    const r = aggregatePatientWindow(nights, ASOF, 7);
    expect(r.nightsInWindow).toBe(1);
    expect(r.lastNightDate).toBe("2026-05-17");
  });

  it("accepts a full ISO timestamp in night_date (legacy paths)", () => {
    const nights = [
      {
        night_date: "2026-05-17T03:00:00Z",
        usage_minutes: 360,
        ahi: "1.5",
        leak_rate_l_min: "8",
      },
    ];
    const r = aggregatePatientWindow(nights, ASOF, 7);
    expect(r.lastNightDate).toBe("2026-05-17");
    expect(r.staleDays).toBe(0);
    expect(r.ahiAvg).toBe(1.5);
  });
});

describe("summarizeOverview", () => {
  it("counts active / alerting / stale buckets independently", () => {
    const rows = [
      {
        nightsInWindow: 5,
        staleDays: 0,
        activeAlerts: [],
        hasTherapyLink: true,
      },
      {
        nightsInWindow: 3,
        staleDays: 0,
        activeAlerts: ["leak_rising"],
        hasTherapyLink: true,
      },
      {
        nightsInWindow: 0,
        staleDays: 20,
        activeAlerts: [],
        hasTherapyLink: true,
      },
      {
        nightsInWindow: 0,
        staleDays: null,
        activeAlerts: [],
        hasTherapyLink: false,
      },
      {
        nightsInWindow: 7,
        staleDays: 0,
        activeAlerts: ["usage_dropping", "leak_rising"],
        hasTherapyLink: true,
      },
    ];
    expect(summarizeOverview(rows)).toEqual({
      totalActive: 3,
      totalAlerting: 2,
      totalStale: 1,
    });
  });

  it("returns all zeros on an empty fleet", () => {
    expect(summarizeOverview([])).toEqual({
      totalActive: 0,
      totalAlerting: 0,
      totalStale: 0,
    });
  });
});

describe("labelForTriggerKind", () => {
  it("maps known kinds to human labels", () => {
    expect(labelForTriggerKind("leak_rising")).toBe("Leak rising");
    expect(labelForTriggerKind("usage_dropping")).toBe("Usage dropping");
    expect(labelForTriggerKind("cushion_wear")).toBe("Cushion wear");
    expect(labelForTriggerKind("humidifier_drop")).toBe("Humidifier drop");
    expect(labelForTriggerKind("ahi_elevated")).toBe("AHI elevated");
    expect(labelForTriggerKind("non_adherent_30d")).toBe("Non-adherent 30d");
  });

  it("passes through unknown kinds verbatim", () => {
    expect(labelForTriggerKind("future_signal_v2")).toBe("future_signal_v2");
  });
});
