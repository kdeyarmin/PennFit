// Parity guard between the demo's message-preview fixture and the real
// server-side catalog.
//
// The catalog lives in the API artifact
// (`artifacts/resupply-api/src/lib/message-previews/catalog.ts`) and the
// SPA cannot import across artifacts, so the demo keeps its own copy. That
// duplication is the drift risk this test exists to close: without it the
// demo could advertise a scenario the real page doesn't have (or miss one
// it does), and nobody would notice until someone compared the two by eye.
//
// It compares the two by SCENARIO ID and FIDELITY LABEL — the structural
// facts. Exact wording is checked on the server side (catalog.test.ts),
// which can call the production renderers directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { demoMessagePreviews } from "./message-previews";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root — this file sits at artifacts/cpap-fitter/src/demo/fixtures. */
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const CATALOG = path.join(
  REPO_ROOT,
  "artifacts/resupply-api/src/lib/message-previews/catalog.ts",
);

/**
 * Pull `id` + `fidelity` out of every `out.push({ ... })` block in the
 * server catalog. A regex over source is the only option available here
 * (the SPA's test process can't import the API artifact), but it is a
 * narrow one: both fields are single-line string literals in every entry.
 */
function serverScenarios(): Map<string, string> {
  const src = readFileSync(CATALOG, "utf8");
  // Scan ONLY the builder's body. `MIRRORED_FINGERPRINTS` below it also has
  // `id:` keys, and including them would invent scenarios that don't exist.
  const start = src.indexOf("export function buildMessagePreviews(");
  const end = src.indexOf("return out;", start);
  expect(
    start,
    "buildMessagePreviews not found in the catalog",
  ).toBeGreaterThan(-1);
  expect(end, "the builder's `return out;` not found").toBeGreaterThan(start);
  const body = src.slice(start, end);

  const found = new Map<string, string>();

  // The three reminder scenarios are generated in a loop rather than pushed
  // as literals, so they come from the loop's variant list.
  if (
    /for \(const variant of \["initial", "followup", "final"\] as const\)/.test(
      body,
    )
  ) {
    for (const v of ["initial", "followup", "final"]) {
      found.set(`resupply.reminder.${v}`, "exact");
    }
  }

  // Pair each `id:` with the NEXT `fidelity:` after it. Entries are nested
  // to varying depths (some sit inside an `if (...)` guard), so matching on
  // indentation or on a closing brace is brittle — ordering is not.
  const ids = [...body.matchAll(/\bid: "([^"]+)"/g)];
  const fidelities = [...body.matchAll(/\bfidelity: "([^"]+)"/g)];
  for (const idMatch of ids) {
    const at = idMatch.index ?? 0;
    const next = fidelities.find((f) => (f.index ?? 0) > at);
    if (next) found.set(idMatch[1], next[1]);
  }
  return found;
}

describe("demo message previews mirror the server catalog", () => {
  const server = serverScenarios();
  const demo = new Map(
    demoMessagePreviews().previews.map((p) => [p.id, p.fidelity]),
  );

  it("finds scenarios in the server catalog at all (guards the parser)", () => {
    // If the catalog's shape changes enough to break the regex, this test
    // must fail loudly rather than silently comparing two empty sets.
    expect(server.size).toBeGreaterThan(10);
  });

  it("covers exactly the same scenario ids", () => {
    const missingFromDemo = [...server.keys()].filter((id) => !demo.has(id));
    const extraInDemo = [...demo.keys()].filter((id) => !server.has(id));
    expect(
      missingFromDemo,
      "the real page has scenarios the demo does not seed",
    ).toEqual([]);
    expect(
      extraInDemo,
      "the demo advertises scenarios the real page does not have",
    ).toEqual([]);
  });

  it("labels each scenario's fidelity the same way", () => {
    const mismatched = [...server.entries()]
      .filter(([id, fidelity]) => demo.get(id) !== fidelity)
      .map(
        ([id, fidelity]) => `${id}: server=${fidelity} demo=${demo.get(id)}`,
      );
    expect(mismatched).toEqual([]);
  });

  it("points every demo scenario at a source file that exists", () => {
    for (const p of demoMessagePreviews().previews) {
      const abs = path.join(REPO_ROOT, p.source);
      expect(
        () => readFileSync(abs, "utf8"),
        `${p.id} -> ${p.source}`,
      ).not.toThrow();
    }
  });
});
