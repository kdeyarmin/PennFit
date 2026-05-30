import { describe, it, expect } from "vitest";

import {
  inferReminderSku,
  buildReminderItemsFromOrder,
  mergeReminderItems,
  SKU_DEFAULT_INTERVAL_DAYS,
  type StoredReminderItem,
} from "./order-reminder-enrollment";

describe("inferReminderSku", () => {
  it("maps explicit cushions and standalone pillows to maskCushion", () => {
    expect(inferReminderSku("AirFit P30i Nasal Cushion - Medium")).toBe(
      "maskCushion",
    );
    expect(inferReminderSku("Nasal Pillows Replacement Pack")).toBe(
      "maskCushion",
    );
  });

  it("maps a full mask kit to maskFrameHeadgear", () => {
    expect(inferReminderSku("ResMed AirFit P30i Nasal Pillow Mask")).toBe(
      "maskFrameHeadgear",
    );
    expect(inferReminderSku("DreamWear Full Face Mask")).toBe(
      "maskFrameHeadgear",
    );
  });

  it("distinguishes disposable vs reusable filters", () => {
    expect(inferReminderSku("Disposable Ultra-Fine Filter (6pk)")).toBe(
      "disposableFilter",
    );
    expect(inferReminderSku("Reusable Foam Filter")).toBe("reusableFilter");
  });

  it("maps tubing, headgear, chamber", () => {
    expect(inferReminderSku("Standard 6ft Tubing")).toBe("tubing");
    expect(inferReminderSku("ClimateLineAir Heated Hose")).toBe("tubing");
    expect(inferReminderSku("Replacement Headgear Straps")).toBe("headgear");
    expect(inferReminderSku("Humidifier Water Chamber")).toBe("waterChamber");
  });

  it("returns null for non-consumables", () => {
    expect(inferReminderSku("AirSense 11 CPAP Machine")).toBeNull();
    expect(inferReminderSku("CPAP Cleaning Wipes")).toBeNull();
    expect(inferReminderSku("Travel Carrying Case")).toBeNull();
  });
});

describe("buildReminderItemsFromOrder", () => {
  const today = "2026-05-30";

  it("creates one item per distinct consumable SKU with next-due dates", () => {
    const items = buildReminderItemsFromOrder(
      [
        { name: "Nasal Cushion - Medium" },
        { name: "Standard Tubing" },
        { name: "AirSense 11 Machine" }, // skipped
      ],
      today,
    );
    expect(items).toHaveLength(2);
    const cushion = items.find((i) => i.sku === "maskCushion")!;
    expect(cushion.lastReplacedAt).toBe(today);
    expect(cushion.intervalDays).toBe(SKU_DEFAULT_INTERVAL_DAYS.maskCushion);
    expect(cushion.nextDueAt).toBe("2026-06-29"); // +30d
    const tubing = items.find((i) => i.sku === "tubing")!;
    expect(tubing.nextDueAt).toBe("2026-08-28"); // +90d
  });

  it("dedupes repeated categories", () => {
    const items = buildReminderItemsFromOrder(
      [{ name: "Nasal Cushion S" }, { name: "Nasal Cushion M" }],
      today,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.sku).toBe("maskCushion");
  });

  it("returns [] when the order has no consumables", () => {
    const items = buildReminderItemsFromOrder(
      [{ name: "CPAP Machine" }, { name: "Carrying Case" }],
      today,
    );
    expect(items).toEqual([]);
  });
});

describe("mergeReminderItems", () => {
  const mk = (sku: string): StoredReminderItem => ({
    sku: sku as StoredReminderItem["sku"],
    lastReplacedAt: "2026-05-30",
    intervalDays: 30,
    nextDueAt: "2026-06-29",
  });

  it("adds only SKUs not already present (existing wins)", () => {
    const merged = mergeReminderItems(
      [mk("maskCushion")],
      [mk("maskCushion"), mk("tubing")],
    );
    expect(merged.map((i) => i.sku).sort()).toEqual(["maskCushion", "tubing"]);
  });

  it("is a no-op when all incoming SKUs already exist", () => {
    const existing = [mk("maskCushion"), mk("tubing")];
    const merged = mergeReminderItems(existing, [mk("tubing")]);
    expect(merged).toHaveLength(2);
  });
});
