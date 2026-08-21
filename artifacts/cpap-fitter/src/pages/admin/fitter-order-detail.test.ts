// Source-pin: fulfillment must see the size the fitter recommended.
// The clinical path stores it on payload.chosenMask.size; the admin
// detail page used to list mask / model / id only.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "fitter-order-detail.tsx"),
  "utf8",
);

describe("AdminOrderDetail — recommended size", () => {
  it("renders a Recommended size field from payload.chosenMask.size", () => {
    expect(SRC).toContain('label="Recommended size"');
    expect(SRC).toContain("payload.chosenMask");
    expect(SRC).toContain("chosenMask.size");
  });
});
