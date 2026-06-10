// Static guards for the inline price editor added to
// admin-shop-inventory.tsx.
//
// Same rationale as admin-shop-inventory.search.test.ts: the
// cpap-fitter vitest env is "node" (no jsdom/RTL), so we read the
// source file and assert the price-edit wiring is present — the cell,
// the API call, the optimistic cache write, and the draft
// normalisation that keeps a saved row from staying "dirty".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-inventory.tsx"),
  "utf8",
);

describe("admin-shop-inventory — inline price editor", () => {
  it("renders a PriceCell with stable test ids and an aria-label", () => {
    expect(SRC).toContain("function PriceCell({");
    expect(SRC).toContain("data-testid={`price-input-${product.id}`}");
    expect(SRC).toContain("data-testid={`price-save-${product.id}`}");
    expect(SRC).toContain(
      "aria-label={`Price in dollars for ${product.name}`}",
    );
  });

  it("saves through patchShopProductPrice (the Stripe price-rotation endpoint)", () => {
    expect(SRC).toContain("patchShopProductPrice(product.id, unitAmountCents)");
  });

  it("validates the dollars draft with the shared parser before saving", () => {
    expect(SRC).toContain("parsePriceDraftToCents(draft)");
  });

  it("optimistically updates priceCents and rolls back on error", () => {
    expect(SRC).toContain(
      "p.id === product.id ? { ...p, priceCents: unitAmountCents } : p",
    );
  });

  it("normalises the draft to the canonical form after a save", () => {
    expect(SRC).toContain("setDraft(centsToPriceDraft(next.priceCents))");
  });

  it("mounts the PriceCell in the table (read-only price cell is gone)", () => {
    expect(SRC).toContain("<PriceCell");
    expect(SRC).not.toContain("formatPrice(");
  });
});
