// Tests pin the cadence catalog + the due-date bucketing so a
// future refactor can't quietly drift the daily/weekly/monthly
// expectations or shift the "due_soon" boundary.

import { describe, it, expect } from "vitest";

import {
  MAINTENANCE_CATALOG,
  MAINTENANCE_TASK_KEYS,
  bucketizeMaintenance,
  findMaintenanceTask,
} from "./catalog";

describe("MAINTENANCE_CATALOG", () => {
  it("has the five expected tasks", () => {
    expect(MAINTENANCE_TASK_KEYS).toEqual([
      "mask_cushion_wipe",
      "mask_wash",
      "tubing_wash",
      "humidifier_chamber_wash",
      "filter_replace",
    ]);
  });

  it("daily / weekly / monthly cadences match manufacturer consensus", () => {
    const byKey = Object.fromEntries(
      MAINTENANCE_CATALOG.map((t) => [t.key, t.frequencyDays]),
    );
    expect(byKey.mask_cushion_wipe).toBe(1);
    expect(byKey.mask_wash).toBe(7);
    expect(byKey.tubing_wash).toBe(7);
    expect(byKey.humidifier_chamber_wash).toBe(7);
    expect(byKey.filter_replace).toBe(30);
  });

  it("every key passes the schema's task_key regex", () => {
    for (const t of MAINTENANCE_CATALOG) {
      expect(t.key).toMatch(/^[a-z0-9_]{1,64}$/);
    }
  });
});

describe("findMaintenanceTask", () => {
  it("finds known keys", () => {
    expect(findMaintenanceTask("mask_wash")?.label).toBe(
      "Wash mask + headgear",
    );
  });
  it("returns undefined for unknown keys", () => {
    expect(findMaintenanceTask("not_a_task")).toBeUndefined();
  });
});

describe("bucketizeMaintenance", () => {
  const asOfDate = new Date("2026-05-12T12:00:00Z");

  it("treats never-completed as due_now today", () => {
    const r = bucketizeMaintenance({
      lastCompletedAt: null,
      frequencyDays: 7,
      asOfDate,
    });
    expect(r.bucket).toBe("due_now");
    expect(r.nextDueDate).toBe("2026-05-12");
  });

  it("treats just-completed as current", () => {
    const r = bucketizeMaintenance({
      lastCompletedAt: "2026-05-12T00:00:00Z",
      frequencyDays: 7,
      asOfDate,
    });
    expect(r.bucket).toBe("current");
    expect(r.daysUntilDue).toBeGreaterThan(1);
  });

  it("buckets the day before due as due_soon", () => {
    // Completed 6 days ago, weekly cadence → due tomorrow → due_soon.
    const lastCompleted = new Date(asOfDate);
    lastCompleted.setUTCDate(lastCompleted.getUTCDate() - 6);
    const r = bucketizeMaintenance({
      lastCompletedAt: lastCompleted.toISOString(),
      frequencyDays: 7,
      asOfDate,
    });
    expect(r.bucket).toBe("due_soon");
  });

  it("buckets overdue tasks as due_now", () => {
    const lastCompleted = new Date(asOfDate);
    lastCompleted.setUTCDate(lastCompleted.getUTCDate() - 14);
    const r = bucketizeMaintenance({
      lastCompletedAt: lastCompleted.toISOString(),
      frequencyDays: 7,
      asOfDate,
    });
    expect(r.bucket).toBe("due_now");
    expect(r.daysUntilDue).toBeLessThan(0);
  });
});
