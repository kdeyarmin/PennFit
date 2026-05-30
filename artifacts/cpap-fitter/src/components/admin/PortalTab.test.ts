// Tests for components/admin/PortalTab.tsx
//
// PR change (a11y): four address input fields in the portal invite form
// were given aria-label attributes so screen-reader users can identify
// them. Fields changed:
//   - Line 2 (apt/suite/unit): aria-label="Apt, suite, unit"
//   - City: aria-label="City"
//   - State: aria-label="State"
//   - ZIP: aria-label="ZIP"

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "PortalTab.tsx"), "utf8");

// ---------------------------------------------------------------------------
// a11y: aria-labels on the address form fields
// ---------------------------------------------------------------------------

describe("PortalTab — a11y: address form aria-labels", () => {
  it("line-2 input has aria-label='Apt, suite, unit'", () => {
    expect(SRC).toContain('aria-label="Apt, suite, unit"');
  });

  it("city input has aria-label='City'", () => {
    expect(SRC).toContain('aria-label="City"');
  });

  it("state input has aria-label='State'", () => {
    expect(SRC).toContain('aria-label="State"');
  });

  it("ZIP input has aria-label='ZIP'", () => {
    expect(SRC).toContain('aria-label="ZIP"');
  });
});

// ---------------------------------------------------------------------------
// a11y: aria-labels placed on the correct inputs (proximity check)
// ---------------------------------------------------------------------------

describe("PortalTab — a11y: aria-labels are on the correct inputs", () => {
  it("City aria-label is near the portal-addr-city id", () => {
    const ariaIdx = SRC.indexOf('aria-label="City"');
    const idIdx = SRC.indexOf('id="portal-addr-city"');
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - idIdx)).toBeLessThan(200);
  });

  it("State aria-label is near the portal-addr-state id", () => {
    const ariaIdx = SRC.indexOf('aria-label="State"');
    const idIdx = SRC.indexOf('id="portal-addr-state"');
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - idIdx)).toBeLessThan(200);
  });

  it("ZIP aria-label is near the portal-addr-zip id", () => {
    const ariaIdx = SRC.indexOf('aria-label="ZIP"');
    const idIdx = SRC.indexOf('id="portal-addr-zip"');
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - idIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("PortalTab — structural invariants", () => {
  it("exports PortalTab", () => {
    expect(SRC).toContain("export function PortalTab");
  });
});
