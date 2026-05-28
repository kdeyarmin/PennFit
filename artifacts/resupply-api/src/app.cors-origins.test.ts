// Static source-level guard for the CORS allowed-origins resolution
// logic in app.ts.
//
// The changed code (PR: add RAILWAY_PUBLIC_DOMAIN as fallback origin
// source) adds a second resolution path to the allowedOrigins IIFE:
//
//   1. RESUPPLY_ALLOWED_ORIGINS — explicit comma-separated list.
//   2. RAILWAY_PUBLIC_DOMAIN   — auto-populated by Railway; wrapped
//      in https:// to match the platform's TLS termination.
//   3. Dev localhost fallback   — non-production only.
//
// The IIFE runs at module-load time, which makes per-scenario env
// manipulation tests brittle and slow. The static approach used by
// app.middleware-order.test.ts is a better fit: it pins the specific
// structural invariants that the PR must preserve without needing
// a live DB pool, configured Stripe/Supabase keys, or multiple
// module-reload cycles.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "app.ts"), "utf8");

/** Strip line and block comments so text searches aren't confused by
 * documentation references to the same identifier. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(APP_SOURCE);

describe("app.ts CORS allowedOrigins — RAILWAY_PUBLIC_DOMAIN integration", () => {
  it("reads RAILWAY_PUBLIC_DOMAIN from process.env", () => {
    // The variable must be accessed (not just mentioned in a comment)
    // in the executable part of the file.
    expect(CODE).toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("wraps RAILWAY_PUBLIC_DOMAIN in https:// to match Railway TLS termination", () => {
    // The origin list entry must be constructed as `https://${railwayHost}`
    // so the scheme matches the browser Origin header sent to the
    // edge-terminated HTTPS endpoint.
    expect(CODE).toContain("`https://${railwayHost}`");
  });

  it("de-duplicates the merged origin list via Set", () => {
    // A custom domain present in both RESUPPLY_ALLOWED_ORIGINS and
    // RAILWAY_PUBLIC_DOMAIN should not appear twice in the allowlist.
    // The implementation must use a Set (or equivalent) to achieve this.
    expect(CODE).toContain("new Set(");
    // The spread puts explicit origins first, Railway origins second —
    // preserving priority order.
    expect(CODE).toMatch(/new Set\(\s*\[\s*\.\.\.explicit\s*,\s*\.\.\.fromRailway\s*\]/);
  });

  it("places explicit RESUPPLY_ALLOWED_ORIGINS before Railway origins in the merge", () => {
    // Priority: explicit > railway. The spread order in the Set
    // constructor encodes this: ...explicit must appear before ...fromRailway.
    const setPattern = /new Set\(\s*\[([^\]]+)\]\s*\)/;
    const match = CODE.match(setPattern);
    expect(match).not.toBeNull();
    const innerSpread = match![1];
    const explicitIdx = innerSpread.indexOf("...explicit");
    const railwayIdx = innerSpread.indexOf("...fromRailway");
    expect(explicitIdx).toBeGreaterThan(-1);
    expect(railwayIdx).toBeGreaterThan(-1);
    expect(explicitIdx).toBeLessThan(railwayIdx);
  });

  it("guards the empty-string RAILWAY_PUBLIC_DOMAIN case with a truthiness check", () => {
    // An empty RAILWAY_PUBLIC_DOMAIN env var (unset or blank) must
    // not produce an invalid `https://` origin. The code must trim and
    // check for truthiness before constructing the URL.
    expect(CODE).toContain(".trim()");
    // The fromRailway assignment must be conditional on a truthy host.
    expect(CODE).toMatch(/railwayHost\s*\?\s*\[/);
  });
});

describe("app.ts CORS allowedOrigins — fail-closed production guard", () => {
  it("throws when BOTH env vars are absent in production (updated condition)", () => {
    // Old condition: RESUPPLY_ALLOWED_ORIGINS missing → throw.
    // New condition: BOTH RESUPPLY_ALLOWED_ORIGINS AND
    //   RAILWAY_PUBLIC_DOMAIN missing → throw.
    // The guard must check the merged list (after de-dup) rather
    // than either variable individually, so that one var alone is
    // sufficient to satisfy the production constraint.
    expect(CODE).toContain('process.env.NODE_ENV === "production"');
    // The throw must happen AFTER the merged list is computed and
    // found to be empty — not before.
    const mergedIdx = CODE.indexOf("const merged =");
    const throwIdx = CODE.indexOf("throw new Error");
    expect(mergedIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(-1);
    expect(mergedIdx).toBeLessThan(throwIdx);
  });

  it("error message names both RESUPPLY_ALLOWED_ORIGINS and RAILWAY_PUBLIC_DOMAIN", () => {
    // The new error message must clearly name both variables so the
    // engineer reading a boot failure knows exactly which env vars
    // to set.
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    const errorText = errorMatch![1];
    expect(errorText).toContain("RESUPPLY_ALLOWED_ORIGINS");
    expect(errorText).toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("error message communicates the OR semantics (either variable is sufficient)", () => {
    // The old message said RESUPPLY_ALLOWED_ORIGINS "must be set".
    // The new message must convey that either variable is acceptable.
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    const errorText = errorMatch![1];
    // "at least one of" is the human-readable phrasing for OR semantics.
    expect(errorText.toLowerCase()).toContain("at least one of");
  });

  it("error message says both vars are empty, not just one", () => {
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    const errorText = errorMatch![1];
    // The new message ends with "Both are empty." rather than the
    // old singular "The variable is empty." — confirming the reviewer
    // that both paths were exhausted before the process aborted.
    expect(errorText.toLowerCase()).toContain("both are empty");
  });
});

describe("app.ts CORS allowedOrigins — dev fallback unchanged", () => {
  it("still includes the four localhost dev-fallback origins", () => {
    // The dev fallback list should be unchanged by this PR:
    // http://localhost, :3000, :5173, :8080.
    expect(CODE).toContain('"http://localhost"');
    expect(CODE).toContain('"http://localhost:3000"');
    expect(CODE).toContain('"http://localhost:5173"');
    expect(CODE).toContain('"http://localhost:8080"');
  });

  it("dev fallback is only reachable when NODE_ENV is not production", () => {
    // The production guard must appear before the dev fallback return
    // so a production boot can never silently fall through to the
    // localhost list.
    const prodGuardIdx = CODE.indexOf('process.env.NODE_ENV === "production"');
    const localhostIdx = CODE.indexOf('"http://localhost"');
    expect(prodGuardIdx).toBeGreaterThan(-1);
    expect(localhostIdx).toBeGreaterThan(-1);
    expect(prodGuardIdx).toBeLessThan(localhostIdx);
  });
});