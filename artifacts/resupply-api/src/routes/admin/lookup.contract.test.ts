// Static guard for the /admin/lookup hardening invariants.
//
// The route is gated by requireAdmin, so the threat model is "an
// authenticated admin sends a malformed query — what happens?". Two
// invariants matter:
//   1. There MUST be an early length cap before any regex/DB work
//      runs. Without it a multi-MB `q` string burns CPU on every
//      regex test and can hit the slow-query log.
//   2. The Stripe Session regex MUST have an explicit upper bound.
//      Stripe session ids are ~65 chars; an unbounded regex would
//      let an unboundedly long `q` reach the DB as an `=` lookup.
//
// We don't boot Express to verify these — we just parse the route's
// source and assert the constants are present. A reviewer reading
// the test learns the contract; a refactor that drops the cap fails
// CI here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOKUP_SOURCE = readFileSync(path.join(__dirname, "lookup.ts"), "utf8");

describe("/admin/lookup hardening", () => {
  it("declares MAX_QUERY_LENGTH and short-circuits before regex/DB work", () => {
    expect(LOOKUP_SOURCE).toMatch(/MAX_QUERY_LENGTH\s*=\s*(\d+)/);
    // The cap must apply BEFORE the 3-char minimum check (the route
    // already had that one). Easiest way to verify: the cap branch
    // must appear before "q.length < 3" in the source.
    const capIdx = LOOKUP_SOURCE.indexOf("MAX_QUERY_LENGTH");
    const minIdx = LOOKUP_SOURCE.indexOf("q.length < 3");
    expect(capIdx).toBeGreaterThan(-1);
    expect(minIdx).toBeGreaterThan(-1);
    // Specifically: the if-guard using MAX_QUERY_LENGTH must precede
    // the < 3 guard so the cap fires first.
    const capGuardIdx = LOOKUP_SOURCE.search(
      /if\s*\(\s*raw\.length\s*>\s*MAX_QUERY_LENGTH\s*\)/,
    );
    expect(capGuardIdx).toBeGreaterThan(-1);
    expect(capGuardIdx).toBeLessThan(minIdx);
  });

  it("Stripe session regex has an explicit upper bound", () => {
    // The original regex was /^cs_[a-zA-Z0-9_]{20,}$/ — open-ended.
    // The hardened version must include an upper bound. We extract
    // the regex literal text and verify the quantifier is closed.
    const m = LOOKUP_SOURCE.match(/STRIPE_SESSION_RE\s*=\s*(\/[^\n]+\/[a-z]*)/);
    expect(m).not.toBeNull();
    const literal = m![1]!;
    // Must contain a closed `{min,max}` quantifier — not the
    // open-ended `{min,}` form.
    expect(literal).toMatch(/\{\d+\s*,\s*\d+\}/);
    expect(literal).not.toMatch(/\{\d+\s*,\s*\}/);
  });

  it("phone, hex-tail, and UUID regexes remain bounded", () => {
    // Phone: bounded {6,18}.
    expect(LOOKUP_SOURCE).toMatch(/PHONE_RE\s*=\s*[^\n]*\{6,18\}/);
    // Hex tail: bounded {8,40}.
    expect(LOOKUP_SOURCE).toMatch(/HEX_TAIL_RE\s*=\s*[^\n]*\{8,40\}/);
    // UUID: exact lengths.
    expect(LOOKUP_SOURCE).toMatch(
      /UUID_RE\s*=\s*\s*\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i/,
    );
  });
});
