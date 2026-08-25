// Drift guard: the cash-pay storefront is retired. Patient-facing pages
// must not link to /shop/* (legacy redirects exist, but copy should point
// patients at insurance ordering, account orders, or the mask catalog).

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = __dirname;

const FORBIDDEN = [
  'href="/shop',
  "href='/shop",
  'navigate("/shop',
  "navigate('/shop",
  'setLocation("/shop',
  "setLocation('/shop",
] as const;

const SCAN_DIRS = [
  path.join(SRC_ROOT, "pages"),
  path.join(SRC_ROOT, "components"),
];

const SKIP_FILES = new Set([
  // Legacy redirect wiring is intentional.
  "App.tsx",
  // Admin console surfaces retain historical /admin/shop/* paths.
]);

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "admin") continue;
      out.push(...walkTsx(full));
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    if (SKIP_FILES.has(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("storefront — no patient-facing /shop links", () => {
  const files = SCAN_DIRS.flatMap(walkTsx);

  it("scans patient pages and shared components", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file);
    it(`${rel} does not link to the retired /shop route`, () => {
      const src = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        expect(src, `found ${needle}`).not.toContain(needle);
      }
    });
  }
});
