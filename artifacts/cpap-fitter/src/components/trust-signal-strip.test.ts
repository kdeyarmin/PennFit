// Source-level guard: trust strip must not call the retired reviews
// aggregate (removed with cash-pay). Static badges only.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "trust-signal-strip.tsx"),
  "utf8",
);

describe("TrustSignalStrip — insurance-only residue", () => {
  it("does not import getShopReviewsSiteAggregate", () => {
    expect(SRC).not.toContain("getShopReviewsSiteAggregate");
  });

  it("does not reference the retired site-aggregate path", () => {
    expect(SRC).not.toContain("site-aggregate");
  });

  it("still renders the static privacy + insurance badges", () => {
    expect(SRC).toContain("trust-privacy");
    expect(SRC).toContain("trust-insurance");
    expect(SRC).toContain("trust-guarantee");
    expect(SRC).toContain("trust-shipping");
  });

  it("does not render a live rating chip", () => {
    expect(SRC).not.toContain("trust-rating");
  });
});
