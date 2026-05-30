// Tests for pages/questionnaire.tsx
//
// P4 — the boolean questions now have a third "I'm not sure" tile
// that sends `null` to the fitter store. We mirror the order.test.ts
// pattern (readFileSync + structural assertions) because the
// component uses React hooks that don't render under the node
// vitest environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "questionnaire.tsx"), "utf8");

describe("questionnaire — P4 'I'm not sure' tile", () => {
  it("renders a third tile with a stable data-testid suffix '-unsure'", () => {
    expect(SRC).toContain("data-testid={`button-${currentQ.id}-unsure`}");
  });

  it("the unsure tile dispatches the null value to handleAnswer", () => {
    // Match the specific onClick handler so a future refactor that
    // accidentally maps the tile to `false` would fail this test.
    expect(SRC).toMatch(/onClick=\{\(\) => handleAnswer\(null\)\}/);
  });

  it("handleAnswer accepts null in its parameter type", () => {
    expect(SRC).toMatch(/value:\s*boolean\s*\|\s*string\s*\|\s*null/);
  });

  it("the radiogroup uses a 3-column grid (Yes / No / Unsure)", () => {
    // The Yes/No-only layout used `md:grid-cols-2`; the new layout is
    // `md:grid-cols-3`. Pin the grid choice so a future grid change
    // doesn't silently squeeze the third tile onto its own row.
    expect(SRC).toContain("md:grid-cols-3");
    expect(SRC).not.toContain("md:grid-cols-2 gap-4 mt-4");
  });

  it("the unsure tile shows the human-readable copy", () => {
    expect(SRC).toContain("I&apos;m not sure");
  });

  it("the unsure tile is aria-checked when the answer === null", () => {
    // The other two tiles compare against `true` / `false`; the
    // unsure tile compares against `null`. All three are mutually
    // exclusive at runtime.
    expect(SRC).toMatch(/aria-checked=\{answers\[currentQ\.id\] === null\}/);
  });
});

describe("questionnaire — Yes/No tiles unchanged", () => {
  it("the Yes tile still dispatches true", () => {
    expect(SRC).toMatch(/onClick=\{\(\) => handleAnswer\(true\)\}/);
    expect(SRC).toContain("data-testid={`button-${currentQ.id}-yes`}");
  });

  it("the No tile still dispatches false", () => {
    expect(SRC).toMatch(/onClick=\{\(\) => handleAnswer\(false\)\}/);
    expect(SRC).toContain("data-testid={`button-${currentQ.id}-no`}");
  });
});
