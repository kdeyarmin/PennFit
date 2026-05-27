// Tests for components/admin/ui-shims/index.tsx
//
// PR change (a11y): the Select shim now accepts an `aria-label` prop
// and forwards it to the underlying native <select> element.  When no
// explicit prop is supplied the component falls back to the
// SelectValue placeholder text so that every native select carries
// at least some accessible label.
//
// The vitest environment is "node" (no DOM / jsdom). We read the
// source as a string and assert the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "index.tsx"), "utf8");

// ---------------------------------------------------------------------------
// SelectProps interface — aria-label field
// ---------------------------------------------------------------------------

describe("ui-shims Select — SelectProps interface", () => {
  it('declares "aria-label"?: string in the SelectProps interface', () => {
    // Must appear inside the interface block (between the `interface SelectProps {`
    // opening and its closing brace).
    const ifaceStart = SRC.indexOf("interface SelectProps {");
    const ifaceEnd = SRC.indexOf("}", ifaceStart);
    const ifaceBody = SRC.slice(ifaceStart, ifaceEnd);
    expect(ifaceBody).toContain('"aria-label"?: string');
  });

  it("SelectProps interface does not carry an `unavailable` field", () => {
    const ifaceStart = SRC.indexOf("interface SelectProps {");
    const ifaceEnd = SRC.indexOf("}", ifaceStart);
    const ifaceBody = SRC.slice(ifaceStart, ifaceEnd);
    expect(ifaceBody).not.toContain("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Select function — prop destructuring
// ---------------------------------------------------------------------------

describe("ui-shims Select — function signature", () => {
  it('destructures "aria-label": ariaLabel from props', () => {
    // The destructuring alias syntax `"aria-label": ariaLabel` is required
    // because JS/TS doesn't allow hyphens in binding identifiers.
    expect(SRC).toContain('"aria-label": ariaLabel');
  });

  it("Select is an exported function", () => {
    expect(SRC).toContain("export function Select(");
  });
});

// ---------------------------------------------------------------------------
// Select function — aria-label forwarding to the native <select>
// ---------------------------------------------------------------------------

describe("ui-shims Select — aria-label forwarded to native <select>", () => {
  it("forwards ariaLabel to the native select element", () => {
    // The attribute assignment must appear inside the <select … > opening tag.
    expect(SRC).toMatch(/aria-label=\{ariaLabel/);
  });

  it("falls back to trigger.placeholder when ariaLabel is undefined", () => {
    // The fallback expression is: ariaLabel ?? (trigger.placeholder || undefined)
    // This ensures every native select has an accessible label derived from
    // the SelectValue placeholder even when the consumer omits aria-label.
    expect(SRC).toContain(
      "ariaLabel ?? (trigger.placeholder || undefined)",
    );
  });

  it("does NOT set a hard-coded empty aria-label on the native select", () => {
    // An empty string aria-label is worse than no label.
    expect(SRC).not.toMatch(/aria-label=\{["']{2}\}/);
    expect(SRC).not.toMatch(/aria-label=""/);
  });
});

// ---------------------------------------------------------------------------
// Regression — collectSelectItems / findTriggerProps still present
// ---------------------------------------------------------------------------

describe("ui-shims Select — helper functions retained", () => {
  it("still defines collectSelectItems for walking child nodes", () => {
    expect(SRC).toContain("function collectSelectItems(");
  });

  it("still defines findTriggerProps for extracting placeholder text", () => {
    expect(SRC).toContain("function findTriggerProps(");
  });
});

// ---------------------------------------------------------------------------
// Companion null-render components still present
// ---------------------------------------------------------------------------

describe("ui-shims Select — companion null-render components", () => {
  it("still exports SelectTrigger", () => {
    expect(SRC).toContain("export function SelectTrigger");
  });

  it("still exports SelectValue", () => {
    expect(SRC).toContain("export function SelectValue");
  });

  it("still exports SelectContent", () => {
    expect(SRC).toContain("export function SelectContent");
  });

  it("still exports SelectItem", () => {
    expect(SRC).toContain("export function SelectItem");
  });
});