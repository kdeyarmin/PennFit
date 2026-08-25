import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "mobile-cta-bar.tsx"), "utf8");

describe("mobile-cta-bar.tsx — quick actions", () => {
  it("links Get fitted to /consent", () => {
    expect(SRC).toContain('href="/consent"');
    expect(SRC).toContain("Get fitted");
  });

  it("links Order to /insurance (not the retired /shop route)", () => {
    expect(SRC).toContain('href="/insurance"');
    expect(SRC).toContain(">Order</span>");
    expect(SRC).not.toContain('href="/shop"');
    expect(SRC).toContain('data-testid="mobile-cta-order"');
  });

  it("links Talk to us to /help", () => {
    expect(SRC).toContain('href="/help"');
    expect(SRC).toContain("Talk to us");
  });
});
