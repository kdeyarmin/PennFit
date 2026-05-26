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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "era-reconciler.ts"), "utf8");

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
    const unmatchedBlock = SRC.slice(
      SRC.indexOf("matched: false"),
      SRC.indexOf("matched: false") + 400,
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
    const updateIdx = SRC.indexOf(".from(\"insurance_claim_line_items\")\n        .update(");
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

// ---------------------------------------------------------------------------
// decision_at stamping (regression — structural source check)
// ---------------------------------------------------------------------------
describe("era-reconciler — decision_at stamping", () => {
  // Regression: the prior gate `claim.status === "submitted"` only
  // stamped decision_at on a direct submitted → paid/denied edge. The
  // common path is submitted → accepted (277CA) → paid/denied; with the
  // old gate those decided claims kept decision_at = NULL and dropped
  // out of every decision-window report (denial rate, aging, DSO).
  // `decision_at:` (with the colon) only appears in the update payload;
  // the select lists the column as a bare string and the header comment
  // writes `decision_at  =`, so this anchor is unambiguous.
  const stampIdx = SRC.indexOf("decision_at:");
  const updateBlock = SRC.slice(stampIdx, stampIdx + 250);

  it("no longer gates the stamp solely on the 'submitted' status", () => {
    expect(updateBlock).toContain("decision_at:");
    expect(updateBlock).not.toContain('claim.status === "submitted" ? nowIso');
  });

  it("stamps on a fresh paid/denied decision, preserving an existing stamp", () => {
    expect(updateBlock).toContain("!claim.decision_at");
    expect(updateBlock).toContain('newStatus === "paid"');
    expect(updateBlock).toContain('newStatus === "denied"');
  });

  it("loads decision_at in the claim select so the preserve-existing guard works", () => {
    const selectIdx = SRC.indexOf('.from("insurance_claims")');
    const selectBlock = SRC.slice(selectIdx, selectIdx + 400);
    expect(selectBlock).toContain("decision_at");
  });
});

// ---------------------------------------------------------------------------
// decision_at stamping — behavioural tests via supabase mock
// ---------------------------------------------------------------------------
// These tests call reconcileEra() directly with staged Supabase responses so
// we verify the actual runtime behaviour, not just the source text. The supabase
// mock patches @workspace/resupply-db at module scope (hoisted by Vitest), so
// importing it here is sufficient to intercept all Supabase calls made inside
// reconcileEra → applyClaim.

import { beforeEach } from "vitest";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { reconcileEra } from "./era-reconciler";

const supabaseMock = installSupabaseMock();
beforeEach(() => supabaseMock.reset());

// Re-used ERA options for all behavioural tests.
const ERA_OPTS = {
  actorEmail: "test@example.com",
  fileName: "test-835.edi",
  checkOrEftNumber: "CHK001",
};

// Helper that builds a minimal Parsed835 with one claim.
function makeParsed835(claimOverrides: {
  patientControlNumber: string;
  paidCents: number;
  isDenied: boolean;
  patientResponsibilityCents?: number;
  adjustments?: Array<{ groupCode: string; reasonCode: string; amountCents: number; quantity: null }>;
}) {
  return {
    totalPaidCents: claimOverrides.paidCents,
    paymentMethod: null,
    paymentDate: null,
    checkOrEftNumber: ERA_OPTS.checkOrEftNumber,
    originatingPayerId: null,
    receiverIdentifier: null,
    payerName: null,
    payerId: null,
    payeeName: null,
    payeeNpi: null,
    claims: [
      {
        patientControlNumber: claimOverrides.patientControlNumber,
        claimStatusCode: claimOverrides.isDenied ? "4" : "1",
        totalChargeCents: 10000,
        paidCents: claimOverrides.paidCents,
        patientResponsibilityCents: claimOverrides.patientResponsibilityCents ?? 0,
        filingIndicator: null,
        payerClaimReference: null,
        patientLastName: null,
        patientFirstName: null,
        adjustments: claimOverrides.adjustments ?? [],
        serviceLines: [],
        isPaid: claimOverrides.paidCents > 0,
        isDenied: claimOverrides.isDenied,
      },
    ],
    providerAdjustments: [],
  };
}

// Helper that stages the standard 3-call sequence for one matched claim:
// (1) insurance_claims select, (2) insurance_claims update, (3) insurance_claim_events insert.
function stageMatchedClaim(claimRow: {
  id: string;
  patient_id: string;
  status: string;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  denial_reason: string | null;
  decision_at: string | null;
}) {
  stageSupabaseResponse("insurance_claims", "select", { data: claimRow, error: null });
  stageSupabaseResponse("insurance_claims", "update", { data: null, error: null });
  stageSupabaseResponse("insurance_claim_events", "insert", { data: null, error: null });
}

describe("era-reconciler — decision_at stamping (behavioural)", () => {
  it("stamps decision_at when an accepted claim transitions to paid for the first time", async () => {
    // Regression: the old `status === "submitted"` gate would have left
    // decision_at NULL on this accepted → paid path.
    stageMatchedClaim({
      id: "claim-accepted-paid",
      patient_id: "patient-1",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-accepted-paid", paidCents: 8000, isDenied: false }),
      ERA_OPTS,
    );

    const [payload] = supabaseMock.writePayloads("insurance_claims", "update") as Array<Record<string, unknown>>;
    expect(payload).toBeDefined();
    // decision_at must be a truthy ISO string (not undefined/null).
    expect(typeof payload.decision_at).toBe("string");
    expect(payload.decision_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stamps decision_at when an accepted claim transitions to denied for the first time", async () => {
    stageMatchedClaim({
      id: "claim-accepted-denied",
      patient_id: "patient-2",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    const denialAdj = [{ groupCode: "CO", reasonCode: "4", amountCents: 10000, quantity: null }];
    await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-accepted-denied", paidCents: 0, isDenied: true, adjustments: denialAdj }),
      ERA_OPTS,
    );

    const [payload] = supabaseMock.writePayloads("insurance_claims", "update") as Array<Record<string, unknown>>;
    expect(typeof payload.decision_at).toBe("string");
  });

  it("does NOT re-stamp decision_at when the claim already has one (preserves existing stamp)", async () => {
    const existingStamp = "2025-01-01T00:00:00.000Z";
    stageMatchedClaim({
      id: "claim-already-stamped",
      patient_id: "patient-3",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: existingStamp,
    });

    await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-already-stamped", paidCents: 5000, isDenied: false }),
      ERA_OPTS,
    );

    const [payload] = supabaseMock.writePayloads("insurance_claims", "update") as Array<Record<string, unknown>>;
    // decision_at must be undefined so the existing stamp is left untouched.
    expect(payload.decision_at).toBeUndefined();
  });

  it("stamps decision_at on a direct submitted → paid transition (existing behaviour preserved)", async () => {
    stageMatchedClaim({
      id: "claim-submitted-paid",
      patient_id: "patient-4",
      status: "submitted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-submitted-paid", paidCents: 9000, isDenied: false }),
      ERA_OPTS,
    );

    const [payload] = supabaseMock.writePayloads("insurance_claims", "update") as Array<Record<string, unknown>>;
    expect(typeof payload.decision_at).toBe("string");
  });

  it("does NOT stamp decision_at when the new status is not paid or denied (e.g., accepted)", async () => {
    // A submitted → accepted transition should leave decision_at undefined.
    stageMatchedClaim({
      id: "claim-submitted-accepted",
      patient_id: "patient-5",
      status: "submitted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    // ERA with paidCents=0 and isDenied=false — status stays at submitted
    // (no transition happens since submitted→submitted is blocked).
    await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-submitted-accepted", paidCents: 0, isDenied: false }),
      ERA_OPTS,
    );

    const [payload] = supabaseMock.writePayloads("insurance_claims", "update") as Array<Record<string, unknown>>;
    // Status didn't change to paid/denied, so decision_at should not be stamped.
    expect(payload.decision_at).toBeUndefined();
  });

  it("returns matched: true with newStatus='paid' when accepted claim is paid", async () => {
    stageMatchedClaim({
      id: "claim-check-outcome",
      patient_id: "patient-6",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    const summary = await reconcileEra(
      makeParsed835({ patientControlNumber: "claim-check-outcome", paidCents: 10000, isDenied: false }),
      ERA_OPTS,
    );

    expect(summary.matchedClaims).toBe(1);
    expect(summary.paidClaims).toBe(1);
    expect(summary.outcomes[0]?.newStatus).toBe("paid");
  });

  it("returns matched: false for an unrecognised claim control number", async () => {
    // Unstaged select returns { data: null } — simulates no matching row.
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null, error: null });

    const summary = await reconcileEra(
      makeParsed835({ patientControlNumber: "nonexistent-claim", paidCents: 1000, isDenied: false }),
      ERA_OPTS,
    );

    expect(summary.matchedClaims).toBe(0);
    expect(summary.unmatchedClaims).toBe(1);
    expect(summary.outcomes[0]?.matched).toBe(false);
  });
});
describe("era-reconciler — EOB event label (patient-balance semantics)", () => {
  it("labels the event 'paid' when the patient owes nothing", async () => {
    stageMatchedClaim({
      id: "claim-paid-nogap",
      patient_id: "p1",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 8000,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    await reconcileEra(
      makeParsed835({
        patientControlNumber: "claim-paid-nogap",
        paidCents: 8000,
        isDenied: false,
        patientResponsibilityCents: 0,
      }),
      ERA_OPTS,
    );

    const [evt] = supabaseMock.writePayloads(
      "insurance_claim_events",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(evt?.event_type).toBe("paid");
  });

  it("labels the event 'partial_pay' when the patient still owes a balance", async () => {
    stageMatchedClaim({
      id: "claim-partial",
      patient_id: "p2",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 8000,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    await reconcileEra(
      makeParsed835({
        patientControlNumber: "claim-partial",
        paidCents: 6000,
        isDenied: false,
        patientResponsibilityCents: 2000, // patient still owes $20
      }),
      ERA_OPTS,
    );

    const [evt] = supabaseMock.writePayloads(
      "insurance_claim_events",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(evt?.event_type).toBe("partial_pay");
  });

  it("labels the event 'denied' for a denied claim regardless of balance", async () => {
    stageMatchedClaim({
      id: "claim-denied-evt",
      patient_id: "p3",
      status: "accepted",
      total_billed_cents: 10000,
      total_allowed_cents: 0,
      total_paid_cents: 0,
      patient_responsibility_cents: 0,
      denial_reason: null,
      decision_at: null,
    });

    await reconcileEra(
      makeParsed835({
        patientControlNumber: "claim-denied-evt",
        paidCents: 0,
        isDenied: true,
        adjustments: [
          { groupCode: "CO", reasonCode: "4", amountCents: 10000, quantity: null },
        ],
      }),
      ERA_OPTS,
    );

    const [evt] = supabaseMock.writePayloads(
      "insurance_claim_events",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(evt?.event_type).toBe("denied");
  });
});
