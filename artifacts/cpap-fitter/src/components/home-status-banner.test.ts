// Source guards for the signed-in home status banner after insurance
// due digest replaced Subscribe & Save shipment fields.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "home-status-banner.tsx"),
  "utf8",
);

describe("HomeStatusBanner — insurance due digest", () => {
  it("treats eligibility.soonest as banner signal", () => {
    expect(SRC).toContain("hasSoonest");
    expect(SRC).toContain("data.eligibility?.soonest");
  });

  it("routes due / next-ship tiles to /reminders not /insurance checkout", () => {
    expect(SRC).toContain('href="/reminders"');
    expect(SRC).not.toMatch(/ShipmentTile[\s\S]*href="\/insurance"/);
  });

  it("labels the due tile as Due rather than Ships", () => {
    expect(SRC).toContain("Due {dateLabel}");
    expect(SRC).not.toContain("Ships {dateLabel}");
  });
});
