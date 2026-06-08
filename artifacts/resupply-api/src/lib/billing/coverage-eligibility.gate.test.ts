// Tests for gateCoverageEligibility — the "consult cache, optionally run
// a fresh real-time 270, then decide" helper used by the claim-submit
// precheck. The verifier reads are mocked so the cache-hit / refresh /
// fail-open branches are exercised deterministically.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getCachedEligibilityMock, verifyEligibilityMock } = vi.hoisted(() => ({
  getCachedEligibilityMock: vi.fn(),
  verifyEligibilityMock: vi.fn(),
}));

vi.mock("./eligibility-verifier", () => ({
  getCachedEligibility: getCachedEligibilityMock,
  verifyEligibility: verifyEligibilityMock,
}));

import { gateCoverageEligibility } from "./coverage-eligibility";

beforeEach(() => {
  getCachedEligibilityMock.mockReset();
  verifyEligibilityMock.mockReset();
});

describe("gateCoverageEligibility", () => {
  it("blocks on a cached inactive result without refreshing", async () => {
    getCachedEligibilityMock.mockResolvedValueOnce({
      id: "e1",
      is_active: false,
      requires_prior_auth: false,
    });
    const res = await gateCoverageEligibility("cov-1", "pat-1", "Aetna", {
      refreshIfStale: true,
      requestedByEmail: "ops@x.com",
    });
    expect(res.refreshed).toBe(false);
    expect(res.block).toEqual({
      reason: "inactive",
      payerName: "Aetna",
      eligibilityCheckId: "e1",
    });
    expect(verifyEligibilityMock).not.toHaveBeenCalled();
  });

  it("does not refresh when refreshIfStale is false (fail open on no cache)", async () => {
    getCachedEligibilityMock.mockResolvedValueOnce(null);
    const res = await gateCoverageEligibility("cov-1", "pat-1", "Aetna", {
      refreshIfStale: false,
      requestedByEmail: "ops@x.com",
    });
    expect(res.refreshed).toBe(false);
    expect(res.block).toBeNull();
    expect(verifyEligibilityMock).not.toHaveBeenCalled();
  });

  it("runs a fresh 270 when cache is empty + refresh allowed, then decides on the result", async () => {
    getCachedEligibilityMock
      .mockResolvedValueOnce(null) // initial: stale/missing
      .mockResolvedValueOnce({
        id: "e2",
        is_active: false,
        requires_prior_auth: false,
      }); // re-read after the fresh 270
    verifyEligibilityMock.mockResolvedValueOnce({
      status: "parsed",
      realtime: true,
    });
    const res = await gateCoverageEligibility("cov-2", "pat-2", "UHC", {
      refreshIfStale: true,
      requestedByEmail: "ops@x.com",
    });
    expect(verifyEligibilityMock).toHaveBeenCalledWith({
      insuranceCoverageId: "cov-2",
      patientId: "pat-2",
      requestedByEmail: "ops@x.com",
    });
    expect(res.refreshed).toBe(true);
    expect(res.block?.reason).toBe("inactive");
  });

  it("refreshes but still fails open when the fresh check yields no parsed result", async () => {
    getCachedEligibilityMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    verifyEligibilityMock.mockResolvedValueOnce({
      status: "submitted",
      realtime: false,
    });
    const res = await gateCoverageEligibility("cov-3", "pat-3", "BCBS", {
      refreshIfStale: true,
      requestedByEmail: "ops@x.com",
    });
    expect(res.refreshed).toBe(true);
    expect(res.block).toBeNull();
  });
});
