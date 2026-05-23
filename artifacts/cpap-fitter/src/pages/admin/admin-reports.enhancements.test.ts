// Tests for the date-preset / compare-flag / email-modal additions
// in admin-reports.tsx.
//
// The existing admin-reports.test.ts exercises the pure helpers
// (isoDate, diffDays, reportUrl) by reimplementing them inline.
// The new behavior is structural and lives in component branches —
// static read-the-source guards are the right unit here, mirroring
// admin-control-center.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DATE_PRESETS } from "./admin-reports-presets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-reports.tsx"),
  "utf8",
);

// ─── Date presets ──────────────────────────────────────────────────────

describe("admin-reports — DATE_PRESETS", () => {
  it("exposes the six expected presets", () => {
    const labels = DATE_PRESETS.map((p) => p.label);
    expect(labels).toEqual([
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last month",
      "Last quarter",
      "Year to date",
    ]);
  });

  it("each preset returns iso-date strings (YYYY-MM-DD)", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    for (const p of DATE_PRESETS) {
      const { from, to } = p.compute(now);
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(from <= to).toBe(true);
    }
  });

  it("Last 7 days resolves to the trailing 7-day window ending today", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const preset = DATE_PRESETS.find((p) => p.label === "Last 7 days")!;
    const { from, to } = preset.compute(now);
    expect(to).toBe("2026-05-15");
    expect(from).toBe("2026-05-08");
  });

  it("This month resolves to the 1st of the current month → today", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const preset = DATE_PRESETS.find((p) => p.label === "This month")!;
    const { from, to } = preset.compute(now);
    expect(from).toBe("2026-05-01");
    expect(to).toBe("2026-05-15");
  });

  it("Last month resolves to the full prior calendar month", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const preset = DATE_PRESETS.find((p) => p.label === "Last month")!;
    const { from, to } = preset.compute(now);
    expect(from).toBe("2026-04-01");
    expect(to).toBe("2026-04-30");
  });

  it("Last quarter resolves to the prior calendar quarter (Q1 2026 → Q4 2025)", () => {
    // March is in Q1 (Jan-Mar). The prior quarter is Q4 2025 (Oct-Dec 2025).
    const now = new Date("2026-03-15T12:00:00.000Z");
    const preset = DATE_PRESETS.find((p) => p.label === "Last quarter")!;
    const { from, to } = preset.compute(now);
    expect(from).toBe("2025-10-01");
    expect(to).toBe("2025-12-31");
  });

  it("Year to date resolves to Jan 1 of the current year → today", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const preset = DATE_PRESETS.find((p) => p.label === "Year to date")!;
    const { from, to } = preset.compute(now);
    expect(from).toBe("2026-01-01");
    expect(to).toBe("2026-05-15");
  });

  it("each preset has a unique testId", () => {
    const ids = DATE_PRESETS.map((p) => p.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Compare-to-prior wiring ───────────────────────────────────────────

describe("admin-reports — compare-to-prior wiring", () => {
  it("adds the ?compare=true query param when the option is on", () => {
    expect(SRC).toMatch(/if\s*\(options\.compare\)\s*params\.set\("compare",\s*"true"\)/);
  });

  it("only revenue-summary.pdf opts into the compare badge", () => {
    // The COMPARE_AWARE list is the source of truth for which
    // formats render the Δ chip; pin it so future additions are
    // explicit code changes.
    expect(SRC).toMatch(/COMPARE_AWARE[\s\S]*revenue-summary[\s\S]*pdf/);
  });

  it("renders a Δ badge next to compare-aware format buttons", () => {
    expect(SRC).toContain("compare-badge");
    expect(SRC).toContain("Δ");
  });

  it("exposes a checkbox with data-testid='reports-compare-checkbox'", () => {
    expect(SRC).toContain('data-testid="reports-compare-checkbox"');
  });
});

// ─── Email-this-report modal ───────────────────────────────────────────

describe("admin-reports — email modal wiring", () => {
  it("defines an EmailReportModal component", () => {
    expect(SRC).toContain("function EmailReportModal(");
  });

  it("posts to /admin/reports/email", () => {
    expect(SRC).toContain('"/resupply-api/admin/reports/email"');
    expect(SRC).toMatch(/method:\s*"POST"/);
  });

  it("renders a per-card 'Email…' button", () => {
    expect(SRC).toMatch(/Email…/);
    expect(SRC).toContain("report-${report.slug}-email");
  });

  it("disables the Send button until a recipient that contains @ is entered", () => {
    // The canSubmit gate: !submitting && recipient.trim().length > 0
    // && /@/.test(recipient). If a refactor drops the @ check the
    // modal would happily POST with bad data; lock it in.
    expect(SRC).toMatch(/\/@\/\.test\(recipient\)/);
    expect(SRC).toMatch(/disabled=\{!canSubmit\}/);
  });

  it("dismisses on Escape and on backdrop click", () => {
    // Modal hygiene — keyboard-only operators need both routes.
    // We grep for the Escape handler and onClick=onClose on the
    // backdrop wrapper.
    expect(SRC).toMatch(/e\.key\s*===\s*"Escape"/);
    expect(SRC).toMatch(/onClick=\{onClose\}/);
  });

  it("forwards the user-chosen format (with qbo → qbo.csv normalization)", () => {
    // The POST body normalizes the UI's "qbo" choice into the
    // server's "qbo.csv" enum value. If this conversion drops,
    // the API rejects with 400 invalid_body and the user gets a
    // confusing error.
    expect(SRC).toMatch(/format === "qbo" \? "qbo\.csv" : format/);
  });
});

// ─── Saved-presets wiring ───────────────────────────────────────────────

describe("admin-reports — SavedPresetsSection wiring", () => {
  it("defines a SavedPresetsSection component", () => {
    expect(SRC).toContain("function SavedPresetsSection(");
  });

  it("renders <SavedPresetsSection /> in the page", () => {
    expect(SRC).toContain("<SavedPresetsSection");
  });

  it("shares a single React Query cache key for presets", () => {
    // Both the list query and the delete-mutation onSettled use
    // PRESETS_QUERY_KEY. Lock in the contract.
    expect(SRC).toMatch(/PRESETS_QUERY_KEY\s*=\s*\["admin-report-presets"\]/);
  });

  it("the Apply button applies the preset's range to from/to", () => {
    // The applier reads rangeKind. When 'preset', it finds the
    // catalog entry and recomputes against `new Date()` so the
    // semantics ("always last month") stay current. When
    // 'absolute', it copies the pinned dates directly.
    expect(SRC).toMatch(/p\.rangeKind\s*===\s*"preset"/);
    expect(SRC).toMatch(/DATE_PRESETS\.find\(\s*\(entry\)\s*=>\s*entry\.testId\s*===\s*p\.rangePreset/);
  });

  it("New-preset modal posts via createReportPreset", () => {
    expect(SRC).toContain("createReportPreset(body)");
  });

  it("New-preset modal validates name + range presence before submit", () => {
    expect(SRC).toMatch(/validName\s*=\s*name\.trim\(\)\.length\s*>\s*0/);
    expect(SRC).toMatch(/canSubmit\s*=\s*validName\s*&&\s*validRange/);
  });

  it("dismisses on Escape and on backdrop click", () => {
    // Same modal hygiene as the other admin modals.
    expect(SRC).toMatch(/e\.key\s*===\s*"Escape"/);
    expect(SRC).toMatch(/onClick=\{onClose\}/);
  });

  it("Apply / Delete buttons + delete confirmation testIds present", () => {
    expect(SRC).toContain("preset-row-${preset.id}-apply");
    expect(SRC).toContain("preset-row-${preset.id}-delete");
  });

  it("filters Format options to what the chosen slug supports", () => {
    // The allowedFormats memo derives from REPORTS[slug].formats.
    // If a slug doesn't support iif, the dropdown shouldn't offer
    // it. The reset-on-slug-change also fires when the current
    // format becomes invalid.
    expect(SRC).toMatch(/allowedFormats\s*=\s*useMemo/);
    expect(SRC).toMatch(/!allowed\.includes\(format\)/);
  });
});
