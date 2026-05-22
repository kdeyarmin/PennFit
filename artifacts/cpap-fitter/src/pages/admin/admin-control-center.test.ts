// Static guards for admin-control-center.tsx summary tiles.
//
// The page renders a row of summary tiles (enabled count, disabled
// count, last toggle) above the per-flag list. The component itself
// is a small react-query consumer; rather than wire a DOM render in
// here, we read the source and assert the wiring contract:
//   - SummaryTiles is defined and rendered above FlagsList
//   - The shared QUERY_KEY is reused (so tiles re-render on toggle)
//   - The PHI-free "lastToggle" filter excludes seed rows (where
//     updated_by_email is null) — see the inline comment in the page
//     for the why.
//
// Mirrors the read-the-source pattern used by
// AppShell.control-center.test.ts and other static-guard tests
// across the admin surface.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-control-center.tsx"),
  "utf8",
);

describe("admin-control-center — SummaryTiles wiring", () => {
  it("defines a SummaryTiles component", () => {
    expect(SRC).toContain("function SummaryTiles()");
  });

  it("renders <SummaryTiles /> above <FlagsList />", () => {
    const tilesIdx = SRC.indexOf("<SummaryTiles />");
    const listIdx = SRC.indexOf("<FlagsList />");
    expect(tilesIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(tilesIdx).toBeLessThan(listIdx);
  });

  it("reuses the page's QUERY_KEY so tiles share the flag-list cache", () => {
    // The tiles' useQuery({ queryKey: QUERY_KEY, ... }) line is what
    // lets an optimistic toggle in FlagRow immediately refresh the
    // tile counts. If a future refactor splits the query keys, this
    // invariant breaks silently.
    const summaryStart = SRC.indexOf("function SummaryTiles()");
    const summaryEnd = SRC.indexOf("function Tile(", summaryStart);
    const summaryBody = SRC.slice(summaryStart, summaryEnd);
    expect(summaryBody).toContain("queryKey: QUERY_KEY");
  });

  it("excludes seed rows (null updated_by_email) from the last-toggle tile", () => {
    // PHI / clarity invariant: the migration seeds every flag with a
    // null updated_by_email + a fresh updated_at, so "newest row" is
    // a useless proxy for "last operator action". The page filters to
    // rows where updatedByEmail is not null before picking the max.
    expect(SRC).toMatch(/updatedByEmail !== null/);
  });

  it("exposes the summary section with data-testid='control-center-summary'", () => {
    // The testid is what an e2e / smoke test would look for to assert
    // the tile row rendered; lock it in so it doesn't drift.
    expect(SRC).toContain('data-testid="control-center-summary"');
  });

  it("includes the three expected per-tile test ids", () => {
    expect(SRC).toContain('testId="tile-enabled"');
    expect(SRC).toContain('testId="tile-disabled"');
    expect(SRC).toContain('testId="tile-last-toggle"');
  });

  it("declares a renderRelativeAge helper for the last-toggle tile", () => {
    expect(SRC).toContain("function renderRelativeAge(");
  });
});
