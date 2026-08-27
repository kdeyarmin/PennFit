// Drift guard: platform marketing pages must not advertise patient cash-pay
// checkout after the insurance-only cutover.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(__dirname, "pages");

const FORBIDDEN = [
  "easy ways to pay",
  "Add to cart",
  "at checkout",
  "Subscribe & Save",
  "openBillingPortal",
  "startCheckout",
] as const;

function breathePages(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(PAGES)) {
    if (!entry.startsWith("breathe") || !entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".test.tsx")) continue;
    out.push(path.join(PAGES, entry));
  }
  return out;
}

describe("breathe marketing — no patient cash-pay shopping copy", () => {
  const files = breathePages();

  it("scans breathe*.tsx marketing pages", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of breathePages()) {
    it(`${path.basename(file)} has no forbidden cash-pay tokens`, () => {
      const src = readFileSync(file, "utf8");
      for (const token of FORBIDDEN) {
        expect(src.toLowerCase()).not.toContain(token.toLowerCase());
      }
    });
  }
});
