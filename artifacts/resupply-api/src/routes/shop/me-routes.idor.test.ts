// Structural guard for the signed-in patient-portal surface (S1 in
// docs/app-review-engineering-health-2026-06-09.md).
//
// Every route registered by a `me-*.ts` file holds one customer's data
// (documents, equipment, messages, billing, push subscriptions, …). The
// two invariants that keep it that way:
//
//   1. Every route registration carries the `requireSignedIn` gate —
//      an ungated /shop/me route is publicly readable.
//   2. Every file derives its data scope from a SESSION-attached
//      identity (`req.userCustomerId` / `req.shopCustomerId` /
//      `req.shopCustomerEmail` / `req.userEmail`) — never from a
//      client-controlled body/query field. A file with no session
//      marker is either unscoped (cross-customer leak) or scoping by
//      something the caller chose.
//
// The file list is globbed at runtime so a newly added me-* route file
// is covered automatically — adding one that fails either invariant
// fails CI with the offending file named.
//
// Behavioural supertest coverage here would need the full pf_session +
// Supabase harness per file; this pins the boundary cheaply, in the same
// spirit as insurance-claims-ai-idor.test.ts.
//
// allow-source-read: structural invariant across 24 route files with no
// behavioral equivalent short of a per-file integration harness; the
// auth gate and session accessors are static facts of each source file.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ME_ROUTE_FILES = readdirSync(__dirname)
  .filter((f) => /^me-.*\.ts$/.test(f) && !f.includes(".test."))
  .sort();

const SESSION_SCOPE_MARKERS = [
  "req.userCustomerId",
  "req.shopCustomerId",
  "req.shopCustomerEmail",
  "req.userEmail",
] as const;

// Strip // line comments and /* */ blocks so a marker mentioned in prose
// can't satisfy (or a commented-out registration can't trip) the checks.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("shop/me-* routes — signed-in scoping (IDOR guard)", () => {
  it("found the me-* route files", () => {
    // If the glob ever comes back empty the suite would pass vacuously;
    // pin a floor (23 files as of 2026-06-12, after the Apple Wallet
    // pass route was removed).
    expect(ME_ROUTE_FILES.length).toBeGreaterThanOrEqual(23);
  });

  for (const file of ME_ROUTE_FILES) {
    const src = stripComments(readFileSync(path.join(__dirname, file), "utf8"));

    it(`${file}: every route registration carries requireSignedIn`, () => {
      const fileWideGate = /router\.use\(\s*requireSignedIn/.test(src);
      const registrations = [
        ...src.matchAll(/router\.(get|post|put|patch|delete)\(/g),
      ];
      expect(registrations.length).toBeGreaterThan(0);
      if (fileWideGate) return;
      for (const reg of registrations) {
        // Window from the registration to its handler arrow — the
        // middleware list lives between the path literal and the
        // handler function.
        const start = reg.index!;
        const arrow = src.indexOf("=>", start);
        const windowSrc = src.slice(start, arrow === -1 ? undefined : arrow);
        expect(
          windowSrc,
          `${file}: a ${reg[1]!.toUpperCase()} registration at index ${start} ` +
            `has no requireSignedIn middleware — that route is public`,
        ).toContain("requireSignedIn");
      }
    });

    it(`${file}: scopes data to a session-derived identity`, () => {
      const hasMarker = SESSION_SCOPE_MARKERS.some((m) => src.includes(m));
      expect(
        hasMarker,
        `${file} references none of ${SESSION_SCOPE_MARKERS.join(", ")} — ` +
          `its queries are either unscoped or scoped by client input`,
      ).toBe(true);
    });
  }
});
