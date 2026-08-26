// Drift guard: patient-facing storefront pages must not advertise cash-pay
// shopping after the insurance-only cutover. Admin / platform marketing
// surfaces are out of scope.
//
// allow-source-read: structural scan across every patient page/component —
// no single runtime mount covers the corpus.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = __dirname;

const FORBIDDEN = [
  "cash-pay",
  "Cash-pay",
  "supply shop",
  "Shop CPAP supplies",
  "Add to cart",
  "Continue shopping",
  "free shipping over",
  "at checkout",
] as const;

const SCAN_DIRS = [
  path.join(SRC_ROOT, "pages"),
  path.join(SRC_ROOT, "components"),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "admin" || entry === "breathe") continue;
      out.push(...walk(full));
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    // Platform marketing pages — scanned separately for insurance-only claims.
    if (entry.startsWith("breathe")) continue;
    out.push(full);
  }
  return out;
}

const FORBIDDEN_ACCOUNT = [
  "Saved card",
  "Express checkout",
  "Card details stay with Stripe",
  "openBillingPortal",
] as const;

describe("storefront — no patient-facing cash-pay shopping copy", () => {
  const files = SCAN_DIRS.flatMap(walk).filter((f) => {
    const base = path.basename(f);
    // Comments in source that document the retirement are OK if the
    // forbidden token only appears inside a "// … retired cash-pay …"
    // style note — we still fail on user-visible string literals by
    // scanning the whole file, so exclude the few files that only
    // mention cash-pay in retirement comments.
    return ![
      "storefront-shop-links.test.ts",
      "storefront-cash-pay-copy.test.ts",
      "reminders.tsx", // comment only: documents the retired shop CTA
      "account.tsx", // header comment notes cash-pay retirement; UI guarded below
      "clinical-results.tsx", // comment only: no retail checkout
    ].includes(base);
  });

  it("scans patient pages and shared components", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file);
    it(`${rel} does not advertise cash-pay shopping`, () => {
      const src = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        expect(src, `found ${needle}`).not.toContain(needle);
      }
    });
  }
});

describe("account page — no patient card / Stripe portal UI", () => {
  const src = readFileSync(path.join(SRC_ROOT, "pages", "account.tsx"), "utf8");

  for (const needle of FORBIDDEN_ACCOUNT) {
    it(`does not contain ${needle}`, () => {
      expect(src).not.toContain(needle);
    });
  }
});

describe("breathe FAQ — insurance-only patient payments answer", () => {
  const src = readFileSync(
    path.join(SRC_ROOT, "pages", "breathe-faq.tsx"),
    "utf8",
  );

  it("does not advertise Stripe patient checkout or autopay", () => {
    expect(src).not.toContain(
      "Stripe for checkout, subscriptions, and autopay",
    );
    expect(src).toContain("patients are insurance-only");
  });
});
