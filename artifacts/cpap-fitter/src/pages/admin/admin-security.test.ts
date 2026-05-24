// Tests for pages/admin/admin-security.tsx
//
// PR changes: replaced two window.confirm() calls with useConfirmDialog:
//   1. EnrolledPanel — "Regenerate recovery codes" button.
//      Generating new codes invalidates all existing ones: destructive.
//   2. DeviceList — "Remove device" button.
//      Removing a device is permanent for that device: destructive.
//
// Each sub-component manages its own [confirm, ConfirmDialogEl] instance.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-security.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("admin-security — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });

  it("calls useConfirmDialog() at least twice (EnrolledPanel + DeviceList)", () => {
    const matches = SRC.match(
      /const \[confirm, ConfirmDialogEl\] = useConfirmDialog\(\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// EnrolledPanel — regenerate recovery codes confirm
// ---------------------------------------------------------------------------

describe("admin-security EnrolledPanel — regenerate recovery codes", () => {
  it("onClick handler is async", () => {
    expect(SRC).toContain("onClick={async () => {");
  });

  it("awaits confirm() before regenerating codes", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Regenerate recovery codes?"', () => {
    expect(SRC).toContain('title: "Regenerate recovery codes?"');
  });

  it("description warns that existing codes stop working", () => {
    expect(SRC).toContain(
      "Generate a fresh batch of 10 recovery codes? Your existing codes will stop working.",
    );
  });

  it('uses confirmLabel "Regenerate"', () => {
    expect(SRC).toContain('confirmLabel: "Regenerate"');
  });

  it("marks the regenerate action as destructive:true", () => {
    // Covered by the two destructive:true occurrences (one per component).
    expect(SRC).toContain("destructive: true");
  });

  it("still calls regenerate.mutate() on confirmation", () => {
    expect(SRC).toContain("regenerate.mutate();");
  });
});

// ---------------------------------------------------------------------------
// DeviceList — remove device confirm
// ---------------------------------------------------------------------------

describe("admin-security DeviceList — remove device", () => {
  it('uses title "Remove device?"', () => {
    expect(SRC).toContain('title: "Remove device?"');
  });

  it("description includes the device label and notes other devices stay active", () => {
    expect(SRC).toContain(
      '`Remove "${d.label ?? "this device"}"? Other devices and recovery codes stay active.`',
    );
  });

  it('uses confirmLabel "Remove"', () => {
    expect(SRC).toContain('confirmLabel: "Remove"');
  });

  it("marks the remove-device action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("still calls remove.mutate(d.id) on confirmation", () => {
    expect(SRC).toContain("remove.mutate(d.id);");
  });

  it("no longer uses window.confirm for either security action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}recovery codes/);
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}this device/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in both components
// ---------------------------------------------------------------------------

describe("admin-security — ConfirmDialogEl rendered in JSX", () => {
  it("renders {ConfirmDialogEl} at least twice (once per component)", () => {
    const matches = SRC.match(/\{ConfirmDialogEl\}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Regression: core security page behaviour
// ---------------------------------------------------------------------------

describe("admin-security — regression: core behaviour retained", () => {
  it("exports AdminSecurityPage", () => {
    expect(SRC).toContain("export function AdminSecurityPage");
  });

  it("still imports beginEnrollMfa and disableMfa", () => {
    expect(SRC).toContain("beginEnrollMfa");
    expect(SRC).toContain("disableMfa");
  });

  it("still renders EnrolledPanel and DeviceList internal components", () => {
    expect(SRC).toContain("function EnrolledPanel");
    expect(SRC).toContain("function DeviceList");
  });
});