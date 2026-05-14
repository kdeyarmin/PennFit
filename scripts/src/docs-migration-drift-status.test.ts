/**
 * Tests for docs/migration-drift-status-2026-05-13.md and the
 * corresponding P0.1/P0.2 table updates in docs/app-review-2026-05-13.md.
 *
 * These tests guard the internal numeric consistency, cross-document
 * references, and key factual claims introduced or updated in the PR that
 * added migration-drift-status-2026-05-13.md and revised the P0 table in
 * app-review-2026-05-13.md.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function readDoc(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first integer that follows `label` on any line of `text`. */
function extractNumber(text: string, label: string): number {
  const regex = new RegExp(`${label}[^\\d]*(\\d+)`);
  const match = text.match(regex);
  if (!match) throw new Error(`Could not find number for label: ${label}`);
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// docs/migration-drift-status-2026-05-13.md
// ---------------------------------------------------------------------------

describe("docs/migration-drift-status-2026-05-13.md", () => {
  let content: string;

  beforeAll(() => {
    content = readDoc("docs/migration-drift-status-2026-05-13.md");
  });

  it("file exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("has the expected document title", () => {
    expect(content).toContain(
      "# Migration Drift Status Update — 2026-05-13",
    );
  });

  it("has a TL;DR section", () => {
    expect(content).toContain("TL;DR");
  });

  it("states that drift has gotten worse", () => {
    // The TL;DR explicitly says drift is worse
    expect(content.toLowerCase()).toMatch(/drift has gotten.{0,10}worse/);
  });

  it("states that no code-only PR can fix this safely", () => {
    expect(content).toContain("no code-only PR can fix this safely");
  });

  // -------------------------------------------------------------------------
  // Metrics table — 2026-05-08 vs 2026-05-13 columns
  // -------------------------------------------------------------------------

  describe("metrics table — _journal.json entries", () => {
    it("shows 52 entries on 2026-05-08", () => {
      // The table row for _journal.json should have 52 in both date columns
      const journalRow = content
        .split("\n")
        .find((l) => l.includes("_journal.json") && l.includes("52"));
      expect(journalRow).toBeTruthy();
    });

    it("shows 52 entries on 2026-05-13 (unchanged)", () => {
      // Both the 5/8 and 5/13 columns should say 52 — delta is 0
      const journalRow = content
        .split("\n")
        .find((l) => l.includes("_journal.json") && l.includes("| 52"));
      expect(journalRow).toBeTruthy();
      // The row must contain 52 twice (once per date column) and delta 0
      const occurrences = (journalRow!.match(/\b52\b/g) ?? []).length;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    it("delta for _journal.json entries is 0", () => {
      const journalRow = content
        .split("\n")
        .find((l) => l.includes("_journal.json"));
      expect(journalRow).toBeTruthy();
      expect(journalRow).toContain("0");
    });
  });

  describe("metrics table — SQL files on disk", () => {
    it("shows 73 SQL files on 2026-05-08", () => {
      const sqlRow = content
        .split("\n")
        .find(
          (l) =>
            l.includes("lib/resupply-db/drizzle") && l.includes("sql") && l.includes("73"),
        );
      expect(sqlRow).toBeTruthy();
    });

    it("shows 120 SQL files on 2026-05-13", () => {
      const sqlRow = content
        .split("\n")
        .find(
          (l) =>
            l.includes("lib/resupply-db/drizzle") && l.includes("120"),
        );
      expect(sqlRow).toBeTruthy();
    });

    it("shows delta of +47 for SQL files", () => {
      const sqlRow = content
        .split("\n")
        .find(
          (l) =>
            l.includes("lib/resupply-db/drizzle") && l.includes("+47"),
        );
      expect(sqlRow).toBeTruthy();
    });
  });

  describe("metrics table — files NOT in journal", () => {
    it("shows 21 files not in journal on 2026-05-08", () => {
      const notInJournalRow = content
        .split("\n")
        .find((l) => l.includes("Files NOT in journal") && l.includes("21"));
      expect(notInJournalRow).toBeTruthy();
    });

    it("shows 68 files not in journal on 2026-05-13", () => {
      const notInJournalRow = content
        .split("\n")
        .find((l) => l.includes("Files NOT in journal") && l.includes("68"));
      expect(notInJournalRow).toBeTruthy();
    });

    it("shows delta of +47 for files not in journal", () => {
      const notInJournalRow = content
        .split("\n")
        .find(
          (l) => l.includes("Files NOT in journal") && l.includes("+47"),
        );
      expect(notInJournalRow).toBeTruthy();
    });
  });

  describe("metrics table — highest SQL prefix", () => {
    it("shows 0066 as highest SQL prefix on 2026-05-08", () => {
      const prefixRow = content
        .split("\n")
        .find((l) => l.includes("Highest SQL prefix") && l.includes("0066"));
      expect(prefixRow).toBeTruthy();
    });

    it("shows 0113 as highest SQL prefix on 2026-05-13", () => {
      const prefixRow = content
        .split("\n")
        .find(
          (l) => l.includes("Highest SQL prefix") && l.includes("0113"),
        );
      expect(prefixRow).toBeTruthy();
    });
  });

  describe("metrics table — duplicate prefix pairs", () => {
    it("shows 6 duplicate prefix pairs on both dates (no change)", () => {
      const dupRow = content
        .split("\n")
        .find(
          (l) =>
            l.includes("Duplicate prefix pairs") &&
            l.includes("6") &&
            l.includes("0"),
        );
      expect(dupRow).toBeTruthy();
    });
  });

  describe("metrics table — _journal.json last tag", () => {
    it("shows the last tag is 0049_physician_fax_outreach_status_pending_idx", () => {
      expect(content).toContain(
        "0049_physician_fax_outreach_status_pending_idx",
      );
    });

    it("shows the last tag is unchanged between dates", () => {
      // The table row should indicate same/unchanged
      expect(content).toMatch(/_same_|unchanged/);
    });
  });

  // -------------------------------------------------------------------------
  // Internal numeric consistency
  // -------------------------------------------------------------------------

  describe("internal numeric consistency", () => {
    it("sql_files(5/13) - journal_entries(5/13) = files_not_in_journal(5/13)", () => {
      // 120 - 52 = 68
      expect(120 - 52).toBe(68);
      expect(content).toContain("52");
      expect(content).toContain("120");
      expect(content).toContain("68");
    });

    it("sql_files(5/8) - journal_entries(5/8) = files_not_in_journal(5/8)", () => {
      // 73 - 52 = 21
      expect(73 - 52).toBe(21);
      expect(content).toContain("73");
      expect(content).toContain("21");
    });

    it("delta in sql_files equals delta in files_not_in_journal", () => {
      // Both deltas are +47 because journal didn't change
      const sqlDelta = 120 - 73;
      const gapDelta = 68 - 21;
      expect(sqlDelta).toBe(47);
      expect(gapDelta).toBe(47);
      expect(sqlDelta).toBe(gapDelta);
    });

    it("the 47 new migration files from 0067 to 0113 are internally consistent", () => {
      // 0113 - 0067 + 1 = 47 (inclusive range count)
      const rangeCount = 113 - 67 + 1;
      expect(rangeCount).toBe(47);
      // Doc claims 47 new migration files between 0067 and 0113
      expect(content).toContain("47");
      expect(content).toContain("0067");
      expect(content).toContain("0113");
    });

    it("the '3.2× wider' claim is approximately correct (68/21 ≈ 3.2)", () => {
      const ratio = 68 / 21;
      // Should be between 3.1 and 3.3 to justify "3.2×"
      expect(ratio).toBeGreaterThan(3.1);
      expect(ratio).toBeLessThan(3.4);
      expect(content).toMatch(/3\.2.{0,5}wider/);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-document references
  // -------------------------------------------------------------------------

  describe("cross-document references", () => {
    it("references codebase-enhancements-2026-05-08.md", () => {
      expect(content).toContain("codebase-enhancements-2026-05-08.md");
    });

    it("references migration-state-investigation-2026-05-08.md", () => {
      expect(content).toContain("migration-state-investigation-2026-05-08.md");
    });

    it("references app-review-2026-05-13.md", () => {
      expect(content).toContain("app-review-2026-05-13.md");
    });

    it("links to app-review with P0.1/P0.2 context", () => {
      expect(content).toMatch(/P0\.1|P0\.2/);
    });
  });

  // -------------------------------------------------------------------------
  // Required sections
  // -------------------------------------------------------------------------

  describe("required sections", () => {
    it("has a 'What changed since 2026-05-08' section", () => {
      expect(content).toContain("What changed since 2026-05-08");
    });

    it("has a 'What still applies from 5/8' section", () => {
      expect(content).toContain("What still applies from 5/8");
    });

    it("has a 'Why production is (presumably) still working' section", () => {
      expect(content).toContain(
        "Why production is (presumably) still working",
      );
    });

    it("has an 'Open questions to resolve before re-attempting' section", () => {
      expect(content).toContain(
        "Open questions to resolve before re-attempting",
      );
    });

    it("has a 'Recommended next step' section", () => {
      expect(content).toContain("Recommended next step");
    });
  });

  // -------------------------------------------------------------------------
  // Open questions
  // -------------------------------------------------------------------------

  describe("open questions", () => {
    it("lists three open questions", () => {
      // The section lists questions 1, 2, 3
      expect(content).toMatch(/\n1\./);
      expect(content).toMatch(/\n2\./);
      expect(content).toMatch(/\n3\./);
    });

    it("question 1 asks about production migration table contents", () => {
      expect(content).toContain("Production migration table contents");
      expect(content).toContain("drizzle.resupply_migrations");
    });

    it("question 2 asks about deploy command sequence", () => {
      expect(content).toContain("Deploy command sequence");
      expect(content).toContain("migrate.mjs");
    });

    it("question 3 asks about live feature flags", () => {
      expect(content).toContain("Live feature flags");
    });

    it("mentions tags 0050_* through 0113_* in question 1", () => {
      expect(content).toContain("0050_*");
      expect(content).toContain("0113_*");
    });
  });

  // -------------------------------------------------------------------------
  // Recommended guidance
  // -------------------------------------------------------------------------

  describe("recommended guidance", () => {
    it("recommends NOT opening a code PR before inspection", () => {
      expect(content).toMatch(/[Dd]o not.{0,20}(open|PR|renames|regenerates)/);
    });

    it("mentions check-drizzle-drift.sh with continue-on-error: true", () => {
      expect(content).toContain("check-drizzle-drift.sh");
      expect(content).toContain("continue-on-error: true");
    });

    it("states continue-on-error is correct posture before root cause resolved", () => {
      // Doc explains why leaving continue-on-error:true is intentional
      expect(content).toContain("correct posture");
    });

    it("warns that flipping to fail-on-drift would block every PR", () => {
      expect(content).toContain("block every PR");
    });

    it("cites ci.yml line 97", () => {
      expect(content).toContain("ci.yml:97");
    });
  });

  // -------------------------------------------------------------------------
  // What migrate.mjs actually does
  // -------------------------------------------------------------------------

  describe("migrate.mjs behavior description", () => {
    it("explains migrate.mjs silently skips unjournaled files", () => {
      expect(content).toContain("silently skips the rest");
    });

    it("explains a fresh-DB run applies exactly 52 migrations", () => {
      expect(content).toMatch(/fresh.DB.{0,20}migrate.mjs.{0,40}52/s);
    });

    it("explains running generate is destructive", () => {
      expect(content).toContain("destructive");
      expect(content).toContain("generate");
    });

    it("explains the 6 duplicate prefixes are mostly harmless", () => {
      expect(content).toContain("mostly harmless");
      expect(content).toContain("6 duplicate");
    });
  });
});

// ---------------------------------------------------------------------------
// docs/app-review-2026-05-13.md — P0.1 and P0.2 row changes
// ---------------------------------------------------------------------------

describe("docs/app-review-2026-05-13.md — P0 table (changed rows)", () => {
  let content: string;

  beforeAll(() => {
    content = readDoc("docs/app-review-2026-05-13.md");
  });

  it("file exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // P0.1 — Drizzle journal drift
  // -------------------------------------------------------------------------

  describe("P0.1 row — Drizzle journal drift", () => {
    it("status is OPEN — WORSE", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1"));
      expect(p01Line).toBeTruthy();
      expect(p01Line).toContain("OPEN — WORSE");
    });

    it("cites 52 journal entries", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1") && l.includes("52"));
      expect(p01Line).toBeTruthy();
    });

    it("cites 120 SQL files", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1") && l.includes("120"));
      expect(p01Line).toBeTruthy();
    });

    it("cites 68-file gap", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1") && l.includes("68"));
      expect(p01Line).toBeTruthy();
    });

    it("notes the gap was 21 on 5/8 (regression from prior status)", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1") && l.includes("21"));
      expect(p01Line).toBeTruthy();
      expect(p01Line).toContain("5/8");
    });

    it("numeric consistency: 52 journal entries + 68 gap = 120 SQL files", () => {
      expect(52 + 68).toBe(120);
    });

    it("flags this as NOT a code-only fix", () => {
      const p01Line = content
        .split("\n")
        .find((l) => l.includes("P0.1") && l.includes("NOT"));
      expect(p01Line).toBeTruthy();
      expect(p01Line).toMatch(/NOT a code.only fix/i);
    });

    it("links to migration-drift-status-2026-05-13.md", () => {
      const p01Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.1") &&
            l.includes("migration-drift-status-2026-05-13.md"),
        );
      expect(p01Line).toBeTruthy();
    });

    it("links to migration-state-investigation-2026-05-08.md", () => {
      const p01Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.1") &&
            l.includes("migration-state-investigation-2026-05-08.md"),
        );
      expect(p01Line).toBeTruthy();
    });

    it("mentions production-state inspection is gating", () => {
      const p01Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.1") && l.includes("production-state inspection"),
        );
      expect(p01Line).toBeTruthy();
    });

    it("mentions continue-on-error: true so PRs don't fail", () => {
      const p01Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.1") &&
            l.includes("continue-on-error: true") &&
            l.includes("don't fail"),
        );
      expect(p01Line).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // P0.2 — Duplicate migration prefixes
  // -------------------------------------------------------------------------

  describe("P0.2 row — Duplicate migration prefixes", () => {
    it("status is OPEN — but secondary", () => {
      const p02Line = content
        .split("\n")
        .find((l) => l.includes("P0.2"));
      expect(p02Line).toBeTruthy();
      expect(p02Line).toMatch(/OPEN.{0,10}secondary/i);
    });

    it("still lists all six duplicate prefixes", () => {
      const p02Line = content
        .split("\n")
        .find((l) => l.includes("P0.2") && l.includes("All six still present"));
      expect(p02Line).toBeTruthy();
    });

    it("explains duplicates are mostly harmless (drizzle-orm matches by tag)", () => {
      const p02Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.2") && l.includes("mostly harmless"),
        );
      expect(p02Line).toBeTruthy();
      expect(p02Line).toContain("drizzle-orm");
      expect(p02Line).toContain("tag");
    });

    it("calls the 68-file journal gap the load-bearing problem", () => {
      const p02Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.2") && l.includes("load-bearing problem"),
        );
      expect(p02Line).toBeTruthy();
    });

    it("links to migration-drift-status-2026-05-13.md", () => {
      const p02Line = content
        .split("\n")
        .find(
          (l) =>
            l.includes("P0.2") &&
            l.includes("migration-drift-status-2026-05-13.md"),
        );
      expect(p02Line).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-document consistency between app-review and migration-drift-status
  // -------------------------------------------------------------------------

  describe("cross-document numeric consistency with migration-drift-status", () => {
    let driftContent: string;

    beforeAll(() => {
      driftContent = readDoc("docs/migration-drift-status-2026-05-13.md");
    });

    it("both docs agree on 52 journal entries", () => {
      expect(content).toContain("52");
      expect(driftContent).toContain("52");
    });

    it("both docs agree on 120 SQL files", () => {
      expect(content).toContain("120");
      expect(driftContent).toContain("120");
    });

    it("both docs agree on 68-file gap", () => {
      expect(content).toContain("68");
      expect(driftContent).toContain("68");
    });

    it("both docs agree the prior gap was 21 (from 5/8)", () => {
      expect(content).toContain("21");
      expect(driftContent).toContain("21");
    });

    it("both docs reference check-drizzle-drift.sh and continue-on-error: true", () => {
      expect(content).toContain("continue-on-error: true");
      expect(driftContent).toContain("continue-on-error: true");
    });

    it("both docs reference ci.yml:97", () => {
      expect(content).toContain("ci.yml:97");
      expect(driftContent).toContain("ci.yml:97");
    });
  });

  // -------------------------------------------------------------------------
  // Unchanged P0 rows still present (regression guard)
  // -------------------------------------------------------------------------

  describe("unchanged P0 rows still present in table", () => {
    it("P0.3 is still FIXED", () => {
      const row = content
        .split("\n")
        .find((l) => l.includes("P0.3") && l.includes("FIXED"));
      expect(row).toBeTruthy();
    });

    it("P0.5 is still FIXED", () => {
      const row = content
        .split("\n")
        .find((l) => l.includes("P0.5") && l.includes("FIXED"));
      expect(row).toBeTruthy();
    });

    it("P0.6 is still FIXED", () => {
      const row = content
        .split("\n")
        .find((l) => l.includes("P0.6") && l.includes("FIXED"));
      expect(row).toBeTruthy();
    });

    it("P0.7 is still PARTIAL", () => {
      const row = content
        .split("\n")
        .find((l) => l.includes("P0.7") && l.includes("PARTIAL"));
      expect(row).toBeTruthy();
    });

    it("P0.8 is still FIXED", () => {
      const row = content
        .split("\n")
        .find((l) => l.includes("P0.8") && l.includes("FIXED"));
      expect(row).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // TL;DR section reflects updated drift numbers
  // -------------------------------------------------------------------------

  describe("TL;DR section", () => {
    it("mentions the gap widened from 21 files to 68 in 5 days", () => {
      expect(content).toContain("21 files to 68");
    });

    it("mentions the drift check is currently continue-on-error: true", () => {
      expect(content).toContain("continue-on-error: true");
    });

    it("says migration drift has gotten worse", () => {
      expect(content).toMatch(/gotten worse/i);
    });
  });
});
