// Guards the demo sandbox's tenant isolation.
//
// The public sandbox is the CareMetric Breathe PLATFORM's showcase. Penn
// Home Medical Supply — storefront brand "PennPaps", pennpaps.com,
// assistants "PennBot"/"PennPilot" — is ONE tenant operating on that
// platform, and its brand is that tenant's data. A prospect who clicks
// "Start demo" must never be shown another customer's company as though
// it were the product.
//
// The sandbox drifted into Penn's brand once already, one fixture at a
// time (a staff email here, a location name there), so a grep-level
// guard is the thing that actually holds: any new fixture that names
// Penn fails this test the moment it lands, rather than shipping to the
// marketing site unnoticed.
//
// If you are adding a fixture, take the identity from `./brand` instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEMO_ASSISTANT_ADMIN_NAME,
  DEMO_ASSISTANT_STOREFRONT_NAME,
  DEMO_DOMAIN,
  DEMO_LEGAL_NAME,
  DEMO_STOREFRONT_NAME,
  demoStaffEmail,
} from "./brand";

const DEMO_DIR = fileURLToPath(new URL(".", import.meta.url));

// Penn-tenant brand tokens. Case-insensitive so "pennpaps" in a URL and
// "PennPaps" in prose are both caught.
const PENN_TOKENS = [
  "pennpaps",
  "penn home medical",
  "pennbot",
  "pennpilot",
  "penn paps",
];

// Files whose COMMENTS may name Penn, because they explain why nothing
// else does. This exempts prose only — their fixtures are scanned like
// every other file's. Keep the list short; a new entry should be a note
// about the rule, never a fixture.
const EXPLAINER_FILES = new Set([
  "brand.ts",
  "handlers/misc.ts",
  "handlers/ext10.ts",
  "handlers/settings.ts",
  "fixtures/platform.ts",
]);

// Every source file the sandbox actually ships. Specs are excluded: they
// are not served to anyone, and one of them asserts the ABSENCE of
// "PennPaps" — which this scan would otherwise read as a violation.
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(rel);
  }
  return out;
}

/** A `//`, `*`, or `/*` line — prose, not data the sandbox serves. */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function pennHits(opts: { commentsToo: boolean }): Hit[] {
  const hits: Hit[] = [];
  for (const rel of walk(DEMO_DIR)) {
    const lines = readFileSync(join(DEMO_DIR, rel), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (!opts.commentsToo && isComment(text)) return;
      const lower = text.toLowerCase();
      if (PENN_TOKENS.some((t) => lower.includes(t))) {
        hits.push({ file: rel, line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

function format(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n");
}

describe("demo sandbox tenant isolation", () => {
  it("serves no Penn-tenant brand in any fixture or handler", () => {
    // Data only: comments are checked separately so an explanatory note
    // can survive without whitelisting a whole file's fixtures.
    const hits = pennHits({ commentsToo: false });
    expect(
      hits,
      `The demo sandbox must not carry the Penn Home Medical Supply tenant's ` +
        `brand. Take the identity from ./brand instead:\n${format(hits)}\n`,
    ).toEqual([]);
  });

  it("names Penn in prose only where the rule itself is explained", () => {
    const stray = pennHits({ commentsToo: true }).filter(
      (h) => isComment(h.text) && !EXPLAINER_FILES.has(h.file),
    );
    expect(
      stray,
      `A comment naming the Penn tenant outside the files that document ` +
        `the isolation rule is almost always a stale header describing the ` +
        `sandbox's own fixtures. Update it to the demo tenant:\n${format(stray)}\n`,
    ).toEqual([]);
  });

  it("keeps the sandbox identity non-routable and obviously a demo", () => {
    // RFC 2606 reserves `.example`, so no sandbox link or address can be
    // mistaken for — or ever resolve to — a live tenant's.
    expect(DEMO_DOMAIN.endsWith(".example")).toBe(true);
    expect(demoStaffEmail("demo.csr")).toBe(`demo.csr@${DEMO_DOMAIN}`);
    expect(DEMO_LEGAL_NAME).toMatch(/Demo/);
  });

  it("uses the platform's assistant names, not a tenant's", () => {
    expect(DEMO_STOREFRONT_NAME).toBe("CareMetric Breathe");
    expect(DEMO_ASSISTANT_STOREFRONT_NAME).toBe("CareMetric Assistant");
    expect(DEMO_ASSISTANT_ADMIN_NAME).toBe("CareMetric Copilot");
  });
});
