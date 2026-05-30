// Tests for the AI patch parser and applier.
//
// Schema tests lock down the Zod gate that keeps hallucinated patches
// out of the DB.
//
// Applier tests cover new/changed logic in this PR:
//   - set_prior_auth_number now calls appendPriorAuthNote (writes
//     [ai-pa:…] to notes) instead of writing to claim_number.
//   - recomputeTotals now multiplies billed_cents × quantity
//     (extended charge) instead of summing per-unit billed_cents.

import { describe, expect, it, beforeEach } from "vitest";

// IMPORTANT: the supabase mock must be imported BEFORE ./ai-patch so its
// hoisted vi.mock("@workspace/resupply-db", …) is registered before
// ai-patch.ts binds getSupabaseServiceRoleClient — otherwise the applier
// tests hit the real client and throw "SUPABASE_URL must be set".
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { aiPatchSchema, applyAiPatches } from "./ai-patch";

describe("aiPatchSchema", () => {
  it("accepts a well-formed set_line_modifier patch", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_line_modifier",
      hcpcsCode: "A7038",
      modifierCsv: "NU",
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aiPatchSchema — set_prior_auth_number (new in this PR)
// ---------------------------------------------------------------------------

describe("aiPatchSchema — set_prior_auth_number", () => {
  it("accepts a well-formed set_prior_auth_number patch", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
      authNumber: "PA-2026-00123",
    });
    expect(r.success).toBe(true);
  });

  it("accepts set_prior_auth_number with an optional rationale", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
      authNumber: "PA-9999",
      rationale: "Payer confirmed PA on file",
    });
    expect(r.success).toBe(true);
  });

  it("rejects set_prior_auth_number with an empty authNumber (min 1)", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
      authNumber: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects set_prior_auth_number with authNumber exceeding 64 chars", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
      authNumber: "A".repeat(65),
    });
    expect(r.success).toBe(false);
  });

  it("rejects set_prior_auth_number when authNumber is missing", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
    });
    expect(r.success).toBe(false);
  });

  it("does NOT accept extra unknown fields (strict)", () => {
    const r = aiPatchSchema.safeParse({
      kind: "set_prior_auth_number",
      authNumber: "PA-1",
      extraField: "bad",
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyAiPatches — set_prior_auth_number writes to notes, not claim_number
// ---------------------------------------------------------------------------
// These tests verify the applier-level behaviour that changed in this PR:
// set_prior_auth_number now calls appendPriorAuthNote (appends [ai-pa:…]
// to notes) rather than writing to claim_number.

const supabaseMock = installSupabaseMock();

beforeEach(() => {
  supabaseMock.reset();
});

const CLAIM_ID = "00000000-0000-4000-8000-000000000001";

// Helper: stage the two supabase calls that recomputeTotals makes after
// every applyAiPatches invocation.
function stageRecompute(
  lines: Array<{
    billed_cents: number;
    quantity: number;
    allowed_cents: number;
    paid_cents: number;
  }> = [],
) {
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: lines,
    error: null,
  });
  stageSupabaseResponse("insurance_claims", "update", {
    data: null,
    error: null,
  });
}

describe("applyAiPatches — set_prior_auth_number (appendPriorAuthNote)", () => {
  it("appends [ai-pa:…] marker to notes when the claim has no prior notes", async () => {
    // Round 1 (appendPriorAuthNote): read notes
    stageSupabaseResponse("insurance_claims", "select", {
      data: { notes: null },
      error: null,
    });
    // Round 2 (appendPriorAuthNote): update notes
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });
    // recomputeTotals reads line items then updates header
    stageRecompute();

    const outcomes = await applyAiPatches(CLAIM_ID, [
      { kind: "set_prior_auth_number", authNumber: "PA-123" },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("applied");

    // The update payload must contain notes with the [ai-pa:…] marker.
    const updatePayloads = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    );
    // updatePayloads[0] is the appendPriorAuthNote update, [1] is recomputeTotals
    const notesPayload = updatePayloads[0] as Record<string, unknown>;
    expect(typeof notesPayload.notes).toBe("string");
    expect(notesPayload.notes as string).toContain("[ai-pa:PA-123]");
    // claim_number must NOT be touched — this was the bug the PR fixes.
    expect(notesPayload.claim_number).toBeUndefined();
  });

  it("appends [ai-pa:…] marker after existing notes", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: { notes: "Initial claim notes" },
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });
    stageRecompute();

    await applyAiPatches(CLAIM_ID, [
      { kind: "set_prior_auth_number", authNumber: "PA-456" },
    ]);

    const updatePayloads = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    );
    const notesPayload = updatePayloads[0] as Record<string, unknown>;
    expect(notesPayload.notes as string).toBe(
      "Initial claim notes [ai-pa:PA-456]",
    );
  });

  it("returns skipped when the same authNumber marker already exists in notes (idempotent)", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: { notes: "Prior notes [ai-pa:PA-789]" },
      error: null,
    });
    // No update call should happen for the patch itself
    stageRecompute();

    const outcomes = await applyAiPatches(CLAIM_ID, [
      { kind: "set_prior_auth_number", authNumber: "PA-789" },
    ]);

    expect(outcomes[0]!.status).toBe("skipped");
    expect(outcomes[0]!.message).toContain("prior-auth already noted");
    // Only the recompute update should have fired, not the PA note update.
    expect(supabaseMock.callCount("insurance_claims", "update")).toBe(1);
  });

  it("returns errored when the supabase update fails", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: { notes: null },
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: { message: "db write failed", code: "PGRST500" },
    });
    stageRecompute();

    const outcomes = await applyAiPatches(CLAIM_ID, [
      { kind: "set_prior_auth_number", authNumber: "PA-ERR" },
    ]);

    expect(outcomes[0]!.status).toBe("errored");
    expect(outcomes[0]!.message).toContain("db write failed");
  });
});

// ---------------------------------------------------------------------------
// applyAiPatches — recomputeTotals uses billed_cents × quantity
// ---------------------------------------------------------------------------

describe("applyAiPatches — recomputeTotals uses extended charge (billed_cents × quantity)", () => {
  it("writes total_billed_cents = billed_cents × quantity for a multi-unit line", async () => {
    // The patch itself can be a no-op set_claim_field (we only care about
    // the recomputeTotals side effect).
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });
    // recomputeTotals read: 2 units @ $15.99 each → extended $31.98
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          billed_cents: 1599,
          quantity: 2,
          allowed_cents: 0,
          paid_cents: 0,
        },
      ],
      error: null,
    });
    // recomputeTotals update
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });

    await applyAiPatches(CLAIM_ID, [
      { kind: "set_claim_field", field: "denial_reason", value: "test" },
    ]);

    const updatePayloads = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    );
    // updatePayloads[0] = the field patch, updatePayloads[1] = recomputeTotals
    const recomputePayload = updatePayloads[1] as Record<string, unknown>;
    // 1599 × 2 = 3198, not 1599 (the old per-unit sum would have been 1599).
    expect(recomputePayload.total_billed_cents).toBe(3198);
  });

  it("writes total_billed_cents = sum of per-unit amounts when quantity is 1", async () => {
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          billed_cents: 5000,
          quantity: 1,
          allowed_cents: 4000,
          paid_cents: 3500,
        },
        {
          billed_cents: 2000,
          quantity: 1,
          allowed_cents: 1800,
          paid_cents: 1800,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });

    await applyAiPatches(CLAIM_ID, [
      { kind: "set_claim_field", field: "denial_reason", value: null },
    ]);

    const updatePayloads = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    );
    const recomputePayload = updatePayloads[1] as Record<string, unknown>;
    expect(recomputePayload.total_billed_cents).toBe(7000);
    expect(recomputePayload.total_allowed_cents).toBe(5800);
    expect(recomputePayload.total_paid_cents).toBe(5300);
  });

  it("treats null quantity as 1 (fallback) in the extended-charge computation", async () => {
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        // quantity is null → should default to 1
        {
          billed_cents: 1000,
          quantity: null,
          allowed_cents: 900,
          paid_cents: 800,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: null,
      error: null,
    });

    await applyAiPatches(CLAIM_ID, [
      { kind: "set_claim_field", field: "denial_reason", value: null },
    ]);

    const updatePayloads = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    );
    const recomputePayload = updatePayloads[1] as Record<string, unknown>;
    expect(recomputePayload.total_billed_cents).toBe(1000);
  });
});
