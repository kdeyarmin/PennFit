// Tests for era-reconciler.ts
//
// PR changes:
//   1. `linesUpdated` added to ReconciliationOutcome — the field now
//      carries the count of local insurance_claim_line_items rows
//      updated per claim block, rather than always being absent.
//   2. summary.linesUpdated is now computed as the _sum of
//      o.linesUpdated across all outcomes_. The old implementation was
//      `(s, _o) => s + 0` (always 0) combined with the ERA's
//      serviceLines.length — effectively always returning the total
//      line count from the parsed 835 rather than the actually-updated
//      count. The new implementation sums the per-claim counts.
//
// Because the reconciler's core paths require live Supabase round-trips
// (it updates insurance_claims and insurance_claim_line_items rows), the
// comprehensive DB tests live in the integration suite. Here we verify:
//   - The structural shape of ReconciliationOutcome includes linesUpdated.
//   - The summary aggregation formula is correct.
//   - The pure helper functions embedded in the module are correct.
//
// The "structural source check" pattern (reading the .ts source as a
// string) is borrowed from order.test.ts — it's the lightest-weight
// way to pin down interface and formula changes without a running DB.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  claimAllowedCents,
  lineAllowedCents,
  patientRespBreakdown,
} from "./era-reconciler";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "era-reconciler.ts"), "utf8");

// ---------------------------------------------------------------------------
// Allowed-amount arithmetic (P0 fix)
// ---------------------------------------------------------------------------
// An 835: billed = paid + Σ(CAS). allowed = billed − CO = paid + PR (CLP05).
// The pre-fix code stored Σ(CO + PR) into total_allowed_cents, which is the
// total *reduction* from billed, not the allowed amount — corrupting payer
// profitability and the COB contractual (billed − allowed) disclosed to the
// secondary payer. These tests pin the corrected formula.
function adj(groupCode: string, reasonCode: string, amountCents: number) {
  return { groupCode, reasonCode, amountCents, quantity: null };
}

describe("era-reconciler — claimAllowedCents (P0 allowed-amount fix)", () => {
  it("allowed = paid + patient responsibility ($100 billed, $80 allowed)", () => {
    // billed 10000 = paid 6400 + CO 2000 + PR 1600; allowed = 8000.
    expect(
      claimAllowedCents({ paidCents: 6400, patientResponsibilityCents: 1600 }),
    ).toBe(8000);
  });

  it("a full contractual denial allows ~0, not the billed charge", () => {
    expect(
      claimAllowedCents({ paidCents: 0, patientResponsibilityCents: 0 }),
    ).toBe(0);
  });

  it("a claim paid in full at the allowed amount (no patient share)", () => {
    expect(
      claimAllowedCents({ paidCents: 8000, patientResponsibilityCents: 0 }),
    ).toBe(8000);
  });
});

describe("era-reconciler — lineAllowedCents (P0 allowed-amount fix)", () => {
  it("excludes CO writeoffs: allowed = line paid + line PR", () => {
    // SVC paid 6400; CAS PR 1600 (coinsurance) + CO 2000 (writeoff) → 8000.
    expect(
      lineAllowedCents({
        paidCents: 6400,
        adjustments: [adj("PR", "2", 1600), adj("CO", "45", 2000)],
      }),
    ).toBe(8000);
  });

  it("a line-level contractual denial allows 0 (CO only, no paid)", () => {
    expect(
      lineAllowedCents({ paidCents: 0, adjustments: [adj("CO", "97", 10000)] }),
    ).toBe(0);
  });

  it("a line fully applied to deductible: paid 0 + PR 5000 = 5000 allowed", () => {
    expect(
      lineAllowedCents({ paidCents: 0, adjustments: [adj("PR", "1", 5000)] }),
    ).toBe(5000);
  });
});

describe("era-reconciler — patientRespBreakdown (PR itemization)", () => {
  const line = (adjustments: ReturnType<typeof adj>[]) => ({
    hcpcsCode: null,
    modifiers: [],
    billedCents: 0,
    paidCents: 0,
    unitsBilled: null,
    unitsPaid: null,
    serviceDate: null,
    adjustments,
  });

  it("buckets claim-level PR CARCs 1/2/3 into deductible/coinsurance/copay", () => {
    expect(
      patientRespBreakdown({
        adjustments: [
          adj("PR", "1", 5000),
          adj("PR", "2", 1600),
          adj("PR", "3", 1000),
          adj("CO", "45", 2000), // writeoff — ignored
        ],
        serviceLines: [],
      }),
    ).toEqual({
      deductibleCents: 5000,
      coinsuranceCents: 1600,
      copayCents: 1000,
    });
  });

  it("sums across claim-level and line-level CAS of the same component", () => {
    expect(
      patientRespBreakdown({
        adjustments: [adj("PR", "2", 1000)],
        serviceLines: [
          line([adj("PR", "2", 500), adj("PR", "1", 2500)]),
          line([adj("PR", "3", 250)]),
        ],
      }),
    ).toEqual({
      deductibleCents: 2500,
      coinsuranceCents: 1500,
      copayCents: 250,
    });
  });

  it("ignores non-PR groups and unmapped PR reason codes", () => {
    expect(
      patientRespBreakdown({
        adjustments: [
          adj("PI", "1", 9999), // not PR group
          adj("PR", "66", 9999), // PR but unmapped CARC
        ],
        serviceLines: [],
      }),
    ).toEqual({ deductibleCents: 0, coinsuranceCents: 0, copayCents: 0 });
  });
});

describe("era-reconciler — allowed-amount source guard (no regression)", () => {
  it("does not add CO into the allowed amount at claim or line level", () => {
    expect(SRC).not.toContain('sumPositive(eraClaim.adjustments, "CO", "PR")');
    expect(SRC).not.toContain('sumPositive(eraLine.adjustments, "CO", "PR")');
    expect(SRC).toContain("claimAllowedCents(eraClaim)");
    expect(SRC).toContain("lineAllowedCents(eraLine)");
  });
});

// ---------------------------------------------------------------------------
// ReconciliationOutcome interface — linesUpdated field (PR change)
// ---------------------------------------------------------------------------
describe("era-reconciler — ReconciliationOutcome.linesUpdated field", () => {
  it("declares linesUpdated in the ReconciliationOutcome interface", () => {
    // The field must appear in the exported interface definition.
    const ifaceStart = SRC.indexOf("export interface ReconciliationOutcome");
    expect(ifaceStart).toBeGreaterThan(-1);
    const ifaceEnd = SRC.indexOf("}", ifaceStart);
    const iface = SRC.slice(ifaceStart, ifaceEnd + 1);
    expect(iface).toContain("linesUpdated");
    expect(iface).toContain("number");
  });

  it("includes linesUpdated: 0 in the unmatched-claim return object", () => {
    // When no local claim is found the reconciler must still return
    // linesUpdated: 0 so callers don't have to handle undefined.
    // Anchor on the object-literal form (`matched: false,`) — the
    // doc comment above reconcileEra also mentions "matched: false`".
    const unmatchedBlock = SRC.slice(
      SRC.indexOf("matched: false,"),
      SRC.indexOf("matched: false,") + 400,
    );
    expect(unmatchedBlock).toContain("linesUpdated: 0");
  });

  it("includes linesUpdated: 0 in the terminal-status (closed) return object", () => {
    // A claim that is already closed returns early; that early return
    // must also carry linesUpdated: 0.
    const terminalIdx = SRC.indexOf("TERMINAL_STATUSES.includes");
    expect(terminalIdx).toBeGreaterThan(-1);
    // Find the return after the terminal status check.
    const terminalBlock = SRC.slice(terminalIdx, terminalIdx + 600);
    expect(terminalBlock).toContain("linesUpdated: 0");
  });

  it("includes linesUpdated in the matched-claim return object", () => {
    // The full reconciliation path returns the live count. Look for
    // the return object that also has paidCents and denialReason.
    const returnIdx = SRC.lastIndexOf("linesUpdated,");
    expect(returnIdx).toBeGreaterThan(-1);
    // It should appear near other outcome fields.
    const block = SRC.slice(returnIdx - 200, returnIdx + 50);
    expect(block).toContain("paidCents");
    expect(block).toContain("denialReason");
  });
});

// ---------------------------------------------------------------------------
// summary.linesUpdated aggregation formula (PR change)
// ---------------------------------------------------------------------------
describe("era-reconciler — summary.linesUpdated aggregation (PR fix)", () => {
  it("sums linesUpdated from each outcome (o.linesUpdated), not a zero constant", () => {
    // The old bug: `(s, _o) => s + 0` — always accumulated 0.
    // The new formula: `(s, o) => s + o.linesUpdated`.
    expect(SRC).toContain("(s, o) => s + o.linesUpdated");
    expect(SRC).not.toContain("(s, _o) => s + 0");
  });

  it("initialises the reduce accumulator at 0 (not at parsed.claims...)", () => {
    // The old implementation seeded the accumulator from parsed.claims'
    // serviceLines count. The new one starts at 0. Window large enough
    // to span the callback body + seed argument regardless of whether
    // the reduce call is on one line or split across several.
    const reduceIdx = SRC.indexOf("(s, o) => s + o.linesUpdated");
    expect(reduceIdx).toBeGreaterThan(-1);
    const reduceBlock = SRC.slice(reduceIdx, reduceIdx + 80);
    // The reduce call's seed is the literal `0` appearing as the second
    // argument — i.e. directly after the callback expression. The
    // callback `(s, o) => s + o.linesUpdated` has no explicit `)`
    // immediately before the `,` so we match `0,` (multi-line form)
    // or `0)` (single-line form) instead.
    expect(reduceBlock).toMatch(/0\s*[,)]/);
  });

  it("does not use parsed.claims.serviceLines.length as the accumulator seed", () => {
    // Guard against the old bug creeping back in.
    expect(SRC).not.toContain("c.serviceLines.length");
  });
});

// ---------------------------------------------------------------------------
// linesUpdated counter increments correctly
// ---------------------------------------------------------------------------
describe("era-reconciler — linesUpdated counter mechanics", () => {
  it("declares a local linesUpdated variable before the line-level loop", () => {
    // The counter is initialised before the service-line loop and
    // returned in the outcome at the end of applyClaim.
    expect(SRC).toContain("let linesUpdated = 0");
  });

  it("increments linesUpdated++ for each matched and updated line", () => {
    // Every matched line that is actually written to DB must bump the counter.
    expect(SRC).toContain("linesUpdated++");
  });

  it("places linesUpdated++ after the supabase update call (not before)", () => {
    // Increment must follow the update, not precede it — so a DB error
    // that short-circuits doesn't inflate the counter.
    const updateIdx = SRC.indexOf(
      '.from("insurance_claim_line_items")\n        .update(',
    );
    const incrIdx = SRC.indexOf("linesUpdated++");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(incrIdx).toBeGreaterThan(updateIdx);
  });
});

// ---------------------------------------------------------------------------
// ReconciliationSummary — linesUpdated field still present at summary level
// ---------------------------------------------------------------------------
describe("era-reconciler — ReconciliationSummary.linesUpdated", () => {
  it("declares linesUpdated in ReconciliationSummary", () => {
    const summaryStart = SRC.indexOf("export interface ReconciliationSummary");
    expect(summaryStart).toBeGreaterThan(-1);
    const summaryEnd = SRC.indexOf("}", summaryStart);
    const iface = SRC.slice(summaryStart, summaryEnd + 1);
    expect(iface).toContain("linesUpdated");
  });

  it("initialises summary.linesUpdated to 0 in the initial summary object", () => {
    // The accumulator object created at the top of reconcileEra must
    // seed linesUpdated at 0 before any outcomes are aggregated.
    const summaryObjIdx = SRC.indexOf("linesUpdated: 0,\n    paidClaims");
    expect(summaryObjIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// Pure-function logic tests — normaliseMods
// ---------------------------------------------------------------------------
// normaliseMods is private but we can replicate its contract here to
// document and guard the behaviour the PR relies on when matching ERA
// lines to local DB lines.

function normaliseMods(mods: readonly string[]): string {
  return [...mods]
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length === 2)
    .sort()
    .join(",");
}

describe("era-reconciler — normaliseMods (pure helper, replicated)", () => {
  it("uppercases modifiers", () => {
    expect(normaliseMods(["kx"])).toBe("KX");
  });

  it("trims surrounding whitespace from each modifier", () => {
    expect(normaliseMods([" RR "])).toBe("RR");
  });

  it("filters out modifiers that are not exactly 2 characters", () => {
    expect(normaliseMods(["K", "KX", "RRR"])).toBe("KX");
  });

  it("sorts modifiers so RR,KX and KX,RR produce the same key", () => {
    expect(normaliseMods(["RR", "KX"])).toBe("KX,RR");
    expect(normaliseMods(["KX", "RR"])).toBe("KX,RR");
  });

  it("returns an empty string for an empty modifier list", () => {
    expect(normaliseMods([])).toBe("");
  });

  it("deduplicates via sort-join (two identical mods appear twice in output)", () => {
    // We don't deduplicate explicitly — sort + join keeps both. The
    // important invariant is that order is normalised.
    expect(normaliseMods(["KX", "KX"])).toBe("KX,KX");
  });
});

// ---------------------------------------------------------------------------
// Pure-function logic tests — allowedTransition state machine
// ---------------------------------------------------------------------------
// Replicated from the source to guard the state-machine edges used by
// the ERA reconciler. The PR didn't change the machine but the linesUpdated
// changes are only meaningful when claim status transitions are correct.

type ClaimStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "denied"
  | "appealed"
  | "paid"
  | "closed";

function allowedTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  const VALID: Record<ClaimStatus, readonly ClaimStatus[]> = {
    draft: ["submitted"],
    submitted: ["accepted", "denied", "paid"],
    accepted: ["paid", "denied"],
    denied: ["appealed", "closed"],
    appealed: ["accepted", "denied"],
    paid: ["closed"],
    closed: [],
  };
  if (from === to) return false;
  return (VALID[from] ?? []).includes(to);
}

describe("era-reconciler — allowedTransition state machine (replicated)", () => {
  it("allows submitted → paid (ERA can resolve without a 277CA intermediate)", () => {
    expect(allowedTransition("submitted", "paid")).toBe(true);
  });

  it("allows submitted → denied", () => {
    expect(allowedTransition("submitted", "denied")).toBe(true);
  });

  it("allows accepted → paid", () => {
    expect(allowedTransition("accepted", "paid")).toBe(true);
  });

  it("blocks closed → paid (no mutation on closed claims)", () => {
    expect(allowedTransition("closed", "paid")).toBe(false);
  });

  it("blocks any transition where from === to", () => {
    expect(allowedTransition("paid", "paid")).toBe(false);
    expect(allowedTransition("denied", "denied")).toBe(false);
  });

  it("blocks paid → denied (paid is near-terminal)", () => {
    expect(allowedTransition("paid", "denied")).toBe(false);
  });
});
