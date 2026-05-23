// Static guard for the AppShell.tsx changes in this PR:
//   - /admin/control-center nav entry (System group)
//   - Updated /admin/reports hint text (expanded from CSV-only description)
//   - ToggleLeft icon import from lucide-react
//
// NAV_GROUPS is not exported, so we read the source file directly and
// assert the expected hrefs, labels, hints, and imports are present.
// This mirrors the approach used in AppShell.nav.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(
  path.join(__dirname, "AppShell.tsx"),
  "utf8",
);

// ─── New nav item: Control Center (System group) ─────────────────────────

describe("AppShell NAV_GROUPS — control-center entry (System group)", () => {
  it("registers the /admin/control-center href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/control-center"');
  });

  it("uses 'Control Center' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Control Center"');
  });

  it("uses /admin/control-center as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/control-center"');
  });

  it("includes a hint describing on/off switches for major features", () => {
    // The hint references the key toggles so admins know what this page does.
    expect(APPSHELL_SRC).toContain("On/off switches for major features");
  });

  it("imports ToggleLeft from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("ToggleLeft");
  });
});

// ─── Updated Reports hint text ────────────────────────────────────────────

describe("AppShell NAV_GROUPS — reports entry hint (updated)", () => {
  it("mentions CSV, PDF, and QuickBooks in the reports hint", () => {
    // The reports hint was expanded from CSV-only to include PDF and QB formats.
    expect(APPSHELL_SRC).toContain("CSV");
    expect(APPSHELL_SRC).toContain("PDF");
    expect(APPSHELL_SRC).toContain("QuickBooks");
  });

  it("no longer contains the old 'Operational KPIs and exports' hint text", () => {
    expect(APPSHELL_SRC).not.toContain("Operational KPIs and exports");
  });
});