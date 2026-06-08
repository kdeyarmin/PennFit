// Tests for the shared coverage-eligibility decision used by every
// "check eligibility before X" gate. decideCoverageBlock is pure;
// consultCoverageEligibilityForCoverage adds the cached-271 read.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  consultCoverageEligibilityForCoverage,
  decideCoverageBlock,
} from "./coverage-eligibility";

beforeEach(() => supabaseMock.reset());

describe("decideCoverageBlock", () => {
  it("returns null for a missing eligibility row (fail open)", () => {
    expect(decideCoverageBlock(null, "Aetna")).toBeNull();
  });

  it("blocks an explicitly inactive plan", () => {
    expect(
      decideCoverageBlock(
        { id: "e1", is_active: false, requires_prior_auth: false },
        "Aetna",
      ),
    ).toEqual({
      reason: "inactive",
      payerName: "Aetna",
      eligibilityCheckId: "e1",
    });
  });

  it("blocks when prior auth is required", () => {
    expect(
      decideCoverageBlock(
        { id: "e2", is_active: true, requires_prior_auth: true },
        "UHC",
      ),
    ).toEqual({
      reason: "prior_auth_required",
      payerName: "UHC",
      eligibilityCheckId: "e2",
    });
  });

  it("does not block an active plan with no prior-auth flag", () => {
    expect(
      decideCoverageBlock(
        { id: "e3", is_active: true, requires_prior_auth: false },
        "BCBS",
      ),
    ).toBeNull();
  });

  it("does not block on unknown (null) fields (fail open)", () => {
    expect(
      decideCoverageBlock(
        { id: "e4", is_active: null, requires_prior_auth: null },
        "BCBS",
      ),
    ).toBeNull();
  });

  it("reports 'inactive' when both negatives are present (inactive wins)", () => {
    expect(
      decideCoverageBlock(
        { id: "e5", is_active: false, requires_prior_auth: true },
        "Aetna",
      )?.reason,
    ).toBe("inactive");
  });
});

describe("consultCoverageEligibilityForCoverage", () => {
  it("returns a block when the most recent parsed 271 is inactive", async () => {
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: "eli-1",
        is_active: false,
        requires_prior_auth: false,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
    });
    const block = await consultCoverageEligibilityForCoverage("cov-1", "Aetna");
    expect(block).toEqual({
      reason: "inactive",
      payerName: "Aetna",
      eligibilityCheckId: "eli-1",
    });
  });

  it("returns null when there is no recent parsed result (fail open)", async () => {
    stageSupabaseResponse("eligibility_checks", "select", { data: null });
    expect(
      await consultCoverageEligibilityForCoverage("cov-1", "Aetna"),
    ).toBeNull();
  });

  it("returns null when the cached 271 is active", async () => {
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: "eli-2",
        is_active: true,
        requires_prior_auth: false,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
    });
    expect(
      await consultCoverageEligibilityForCoverage("cov-1", "Aetna"),
    ).toBeNull();
  });
});
