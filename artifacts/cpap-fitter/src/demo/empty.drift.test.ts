// Drift guard for the demo sandbox's "empty everything" fallback body.
//
// empty.ts's header states the rule: "Keep this union broad — a missing name
// is a latent crash." That rule was previously enforced by hope. It failed:
// `tiers` (GET /shop/membership/options) was never seeded, so in demo mode
// `MembershipSection` read `res.tiers` as undefined and `tiers.length` took
// the whole /account page to the ErrorBoundary. The same gap crashed every
// /platform/* page via `data?.tickets.length` in the console sidebar.
//
// This test recomputes the rule instead: every array-typed field declared on
// a response type in the SPA's client layer must appear in
// EMPTY_COLLECTION_KEYS. A new list endpoint whose response field isn't
// seeded fails HERE — at the point the field is introduced — rather than as a
// white screen on an unseeded demo page.
//
// Adding a name is the fix; the fallback body returns `[]` for each, and
// empty.ts already documents that harmless extra keys are simply ignored.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { emptyGetFallbackBody } from "./empty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPA_SRC = path.resolve(__dirname, "..");
const CLIENT_DIRS = [
  path.join(SPA_SRC, "lib"),
  path.resolve(SPA_SRC, "../../../lib/api-client-react/src"),
];

/**
 * `name: Foo[]` / `name?: Array<Foo>` — an array-typed declaration, either on
 * its own line in a `type`/`interface` block or inline inside a generic
 * argument (`jsonFetch<{ tiers: MembershipOption[] }>(...)`). The inline form
 * matters: `tiers` is declared ONLY that way, and missing it is precisely what
 * crashed /account/orders.
 */
const ARRAY_FIELD =
  /(?:^|[{,;<])\s*([A-Za-z_$][\w$]*)\??\s*:\s*(?:readonly\s+)?(?:[A-Za-z_$][\w$.<>|" ]*\[\]|Array<)/g;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      out = out.concat(walk(full));
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    if (full.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

function declaredArrayFields(): Set<string> {
  const names = new Set<string>();
  for (const dir of CLIENT_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      ARRAY_FIELD.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ARRAY_FIELD.exec(src)) !== null) {
        if (m[1]) names.add(m[1]);
      }
    }
  }
  return names;
}

/**
 * Names deliberately seeded as `{}` rather than `[]` because pages INDEX into
 * them (`data.counts[k]`). A couple are declared array-typed somewhere too;
 * the object shape wins, and indexing an object still yields `undefined`
 * instead of throwing, so they are exempt from the array requirement.
 */
const OBJECT_SHAPED = new Set(["counts", "stats", "summary", "totals"]);

describe("demo fallback body covers every array-typed response field", () => {
  it("seeds an empty array for each declared collection name", () => {
    const body = emptyGetFallbackBody();
    const missing = [...declaredArrayFields()]
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

  it("seeds the two names whose absence caused real crashes", () => {
    // Regression pins: `tiers` bricked /account/orders, `tickets` bricked
    // every /platform/* page through the console sidebar's badge query.
    const body = emptyGetFallbackBody();
    expect(Array.isArray(body.tiers)).toBe(true);
    expect(Array.isArray(body.tickets)).toBe(true);
  });

  it("keeps the indexable-object fields as objects, not arrays", () => {
    // `counts` / `stats` / `summary` / `totals` are indexed into
    // (`data.counts[k]`), so they must stay objects.
    const body = emptyGetFallbackBody();
    for (const key of ["counts", "stats", "summary", "totals"]) {
      expect(body[key], `${key} should be an object`).toEqual({});
    }
  });
});
