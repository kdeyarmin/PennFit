// Drift guard for the standalone Virtual Mask Fitter product scope.
//
// The bug this exists to prevent already shipped once: MASK_FITTER_NAV_GROUPS
// listed Fit Review, Mask Catalog, Formulary and Referrals, and the SERVER
// allowed all four — but MASK_FITTER_ALLOWED_ROUTE_PREFIXES did not, so the
// sidebar rendered the links and the route guard bounced every click back to
// Fitter Invites. A fitter-only tenant could not sign off a size band, edit
// their formulary, or open the review queue: the things the plan is sold on.
//
// Three lists have to agree, and none of them can see the others:
//   1. the nav a fitter-only tenant is shown            (this file's import)
//   2. the SPA route guard                              (this file's import)
//   3. the server's 403 gate                            (read from source)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MASK_FITTER_ALLOWED_ROUTE_PREFIXES,
  MASK_FITTER_NAV_GROUPS,
} from "./AppShell";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// allow-source-read: the server allowlist is a module-level literal in a
// SIBLING PACKAGE (resupply-api) that this SPA package must not import at
// runtime. There is no behavioural equivalent — the constant is not served
// over any endpoint — so reading the literal is the only way to compare the
// two gates, exactly as sitemap.drift.test.ts compares App.tsx to sitemap.xml.
const PRODUCT_SCOPE_SRC = readFileSync(
  path.resolve(__dirname, "../../../../resupply-api/src/lib/product-scope.ts"),
  "utf8",
);

function serverAllowlist(): string[] {
  const block = PRODUCT_SCOPE_SRC.split(
    "const MASK_FITTER_ALLOWED_PREFIXES: readonly string[] = [",
  )[1];
  if (!block) throw new Error("server allowlist literal not found");
  const body = block.split("];")[0] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const navHrefs = MASK_FITTER_NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => i.href),
);

describe("every page the fitter-only nav offers is actually reachable", () => {
  it("has at least the clinical pages the plan is sold on", () => {
    // Guards against the opposite regression: silently dropping these from
    // the nav would make this whole file pass vacuously.
    expect(navHrefs).toEqual(
      expect.arrayContaining([
        "/admin/fit-sessions",
        "/admin/fitter/catalog",
        "/admin/fitter/formulary",
      ]),
    );
  });

  it.each(navHrefs)("route guard allows %s", (href) => {
    const allowed = MASK_FITTER_ALLOWED_ROUTE_PREFIXES.some((p) =>
      href.startsWith(p),
    );
    expect(allowed).toBe(true);
  });
});

describe("the pages that call an API are granted that API server-side", () => {
  // NOTE the two namespaces, which is why this is not a set comparison:
  // MASK_FITTER_ALLOWED_ROUTE_PREFIXES holds SPA *page* routes, while the
  // server list holds *API* paths. They coincide for the clinical pages
  // (the page and its endpoint share a path) but not for others —
  // /admin/security is a page whose API is /admin/mfa, and
  // /admin/control-center is a page whose API is /admin/feature-flags.
  // Asserting one list contains the other would encode a false
  // equivalence, so this pins the pairs that actually matter.
  const CLINICAL_PAGES = [
    "/admin/fit-sessions",
    "/admin/fitter/catalog",
    "/admin/fitter/formulary",
    "/admin/provider-referrals",
  ];

  it.each(CLINICAL_PAGES)("server allows %s", (path) => {
    expect(serverAllowlist()).toContain(path);
  });

  it("server allows the API behind Control Center", () => {
    // The page is worthless without it: this is where a fitter-only
    // tenant turns the clinical engine on after their RT signs off the
    // size bands. Without the endpoint the page loads and shows nothing.
    expect(serverAllowlist()).toContain("/admin/feature-flags");
  });

  it("reads a non-empty server allowlist", () => {
    // If the literal were ever renamed, the parser above would silently
    // return nothing and every assertion here would pass for the wrong
    // reason.
    expect(serverAllowlist().length).toBeGreaterThan(5);
  });

  it("does not grant the operational billing suite", () => {
    // The tenant's six subscription endpoints share the /admin/billing/
    // prefix with the entire claims + revenue-cycle suite, including
    // PHI-bearing 837P export. The server list enumerates the six for
    // exactly that reason; a bare prefix would open all of it.
    expect(serverAllowlist()).not.toContain("/admin/billing");
  });
});
