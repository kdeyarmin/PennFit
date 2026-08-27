// Drift guard for the demo sandbox's "empty everything" fallback body.
//
// empty.ts's header states the rule: "Keep this union broad — a missing name
// is a latent crash." That rule was previously enforced by hope, and it failed:
// `tiers` (GET /shop/membership/options) was never seeded, so in demo mode
// `MembershipSection` read `res.tiers` as undefined and `tiers.length` took the
// whole /account page to the ErrorBoundary. Membership checkout is now retired
// (getMembershipOptions hard-fails), so `tiers` is no longer extracted from
// the client layer — empty.ts keeps seeding it harmlessly for any stale demo
// route that still returns it. The same gap crashed every /platform/* page
// via `data?.tickets.length` in the console sidebar.
//
// How the rule is computed
// ------------------------
// From the TypeScript type checker, NOT a regex over type declarations.
//
// The first version of this test regex-scanned every type in the client trees
// and required each array-typed field to be seeded. That was wrong in both
// directions (caught in review on #1260):
//
//   * TOO BROAD — it matched local UI/domain types that are never API
//     responses. `CpapDeviceOption.aliases` (lib/cpap-devices.ts, a static
//     typeahead catalog) was dragged in, so an unrelated type addition would
//     fail this test and push a meaningless key into empty.ts.
//   * TOO NARROW — its character class could not match valid response syntax
//     such as `pendingAgreements?: ("baa" | "platform_terms")[]`, where the
//     element type starts with a parenthesized union.
//
// So it both blocked harmless changes and failed to enforce what it claimed.
// This version asks the checker for the ACTUAL response types: the generic
// argument of every `jsonFetch<T>` / `adminFetch<T>` call in the client layer,
// which is precisely "what the SPA parses out of an API response". Array-typed
// properties of those T's are the keys the demo fallback must seed.
// `checker.isArrayType` handles any element syntax, parenthesized unions
// included. Building the scoped program costs ~2s.

import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { emptyGetFallbackBody } from "./empty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "../..");
/** The client layer — where every API call in the SPA is declared. */
const CLIENT_DIR = path.resolve(__dirname, "../lib");

/** Wrappers whose single type argument IS the parsed response body. */
const FETCH_WRAPPERS = /^(jsonFetch|adminFetch|apiFetch|fetchJson)$/;

/**
 * Names deliberately seeded as `{}` rather than `[]` because pages INDEX into
 * them (`data.counts[k]`). A couple are array-typed somewhere too; the object
 * shape wins, and indexing an object yields `undefined` instead of throwing.
 */
const OBJECT_SHAPED = new Set(["counts", "stats", "summary", "totals"]);

/** Array-typed top-level keys of every fetch response type in the SPA. */
function responseCollectionKeys(): Set<string> {
  const cfgPath = ts.findConfigFile(
    PROJECT_DIR,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!cfgPath) throw new Error("cpap-fitter tsconfig.json not found");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, PROJECT_DIR);
  // Scope the program to the client layer: enough to resolve every response
  // type (imports are pulled in transitively) without compiling the whole SPA.
  const entry = parsed.fileNames.filter(
    (f) => f.startsWith(CLIENT_DIR) && !f.includes(".test."),
  );
  const program = ts.createProgram(entry, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const keys = new Set<string>();
  const addArrayProps = (type: ts.Type) => {
    for (const sym of checker.getPropertiesOfType(type)) {
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      const propType = checker.getTypeOfSymbolAtLocation(sym, decl);
      const parts = propType.isUnion() ? propType.types : [propType];
      if (parts.some((p) => checker.isArrayType(p) || checker.isTupleType(p))) {
        keys.add(sym.getName());
      }
    }
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.startsWith(CLIENT_DIR)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.typeArguments?.length === 1) {
        if (FETCH_WRAPPERS.test(node.expression.getText())) {
          addArrayProps(checker.getTypeFromTypeNode(node.typeArguments[0]!));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return keys;
}

describe("demo fallback body covers every array-typed API response field", () => {
  const keys = responseCollectionKeys();

  it("resolves a meaningful number of response types (guards the extractor itself)", () => {
    // If the wrapper names or the client-layer path ever move, the extractor
    // would silently find nothing and this suite would pass vacuously.
    expect(keys.size).toBeGreaterThan(50);
  });

  it("seeds an empty array for each array-typed response key", () => {
    const body = emptyGetFallbackBody();
    const missing = [...keys]
      .filter((name) => !OBJECT_SHAPED.has(name))
      .filter((name) => !Array.isArray(body[name]))
      .sort();
    expect(
      missing,
      `These array-typed API response fields are not seeded in ` +
        `EMPTY_COLLECTION_KEYS (artifacts/cpap-fitter/src/demo/empty.ts). ` +
        `An unseeded demo GET returns a body without them, so any page doing ` +
        `data.<field>.map(...) / .length crashes into the ErrorBoundary. ` +
        `Add each name to EMPTY_COLLECTION_KEYS.`,
    ).toEqual([]);
  });

  it("excludes local UI/domain types that are not API responses", () => {
    // `CpapDeviceOption.aliases` is a static typeahead catalog, never parsed
    // from a response. The previous regex-based scan dragged it in; requiring
    // it here would be a meaningless key in the demo fallback.
    expect(keys.has("aliases")).toBe(false);
  });

  it("seeds tickets — absence crashed every /platform/* sidebar badge query", () => {
    const body = emptyGetFallbackBody();
    expect(keys.has("tickets")).toBe(true);
    expect(Array.isArray(body.tickets)).toBe(true);
  });

  it("keeps the indexable-object fields as objects, not arrays", () => {
    const body = emptyGetFallbackBody();
    for (const key of OBJECT_SHAPED) {
      expect(body[key], `${key} should be an object`).toEqual({});
    }
  });
});
