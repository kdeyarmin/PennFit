// Static assertions for the root package.json engines.node field.
//
// PR fix R2 (docs/railway-hosting-review-2026-05-29.md): `engines.node`
// was changed from ">=24" (open-ended range) to "24.x" (bounded major).
// An open-ended range like ">=24" lets Railpack silently fall back to Node 22
// or 18 on its default; "24.x" enforces the major without locking to a patch.
//
// We test the JSON value directly rather than via a live process so the check
// is fast, dependency-free, and runs even before pnpm install resolves the
// version. (The authoritative operator-side fix is RAILPACK_NODE_VERSION=24
// in Railway → Variables; this test guards the repo-side signal.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Walk up from artifacts/resupply-api/src to the monorepo root.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as Record<
  string,
  unknown
>;

const engines = PKG["engines"] as Record<string, string> | undefined;

describe("root package.json — engines.node version pin (R2)", () => {
  it("has an engines field", () => {
    expect(engines).toBeDefined();
    expect(typeof engines).toBe("object");
  });

  it('engines.node is set to "24.x" (bounded major, not open-ended range)', () => {
    // "24.x" allows patch/minor updates within Node 24 while preventing
    // Railpack from silently resolving to Node 22 or 18.
    expect(engines?.["node"]).toBe("24.x");
  });

  it('engines.node does NOT use an open-ended range like ">=24"', () => {
    // An open-ended range is the pre-fix value; ensure it was not reinstated.
    const nodeRange = engines?.["node"] ?? "";
    expect(nodeRange).not.toMatch(/^>=/);
  });

  it("engines.node does not use a caret range (^) that would allow major upgrades", () => {
    const nodeRange = engines?.["node"] ?? "";
    expect(nodeRange).not.toMatch(/^\^/);
  });

  it('engines.node major is "24" (matching Railway RAILPACK_NODE_VERSION=24)', () => {
    const nodeRange = engines?.["node"] ?? "";
    // "24.x" satisfies /^24/; a mismatched major (e.g. "22.x") would not.
    expect(nodeRange).toMatch(/^24/);
  });

  it("engines.pnpm is still pinned to >=11.0.0 (unchanged by this PR)", () => {
    // Ensure the pnpm constraint was not accidentally removed while editing.
    expect(engines?.["pnpm"]).toBeTruthy();
    expect(engines?.["pnpm"]).toMatch(/^>=11/);
  });

  it("package.json is valid JSON with a top-level engines object (regression guard)", () => {
    // A malformed package.json parse would throw before reaching here;
    // this assertion documents the invariant explicitly.
    expect(PKG).toHaveProperty("engines");
    expect(typeof PKG["engines"]).toBe("object");
  });
});
