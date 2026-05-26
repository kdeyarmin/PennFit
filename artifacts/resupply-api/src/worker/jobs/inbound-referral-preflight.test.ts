import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const runPreflightMock = vi.fn().mockResolvedValue({ checks: [] });
vi.mock("../../lib/inbound-dispatchers/preflight", () => ({
  runReferralPreflight: (...a: unknown[]) => runPreflightMock(...a),
}));

import { runInboundReferralPreflightTick } from "./inbound-referral-preflight";

const supabaseMock = installSupabaseMock();

describe("runInboundReferralPreflightTick", () => {
  beforeEach(() => {
    supabaseMock.reset();
    runPreflightMock.mockReset().mockResolvedValue({ checks: [] });
  });

  it("reads candidate referrals with a SELECT and runs preflight per row", async () => {
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: [{ id: "ref-1" }, { id: "ref-2" }],
      error: null,
    });

    const stats = await runInboundReferralPreflightTick();

    expect(stats.scanned).toBe(2);
    expect(stats.completed).toBe(2);
    expect(runPreflightMock).toHaveBeenCalledTimes(2);
    expect(runPreflightMock).toHaveBeenCalledWith(
      expect.objectContaining({ referralId: "ref-1" }),
    );
  });

  it("does NOT issue a no-op UPDATE 'claim' on inbound_referral_orders", async () => {
    // The old code did `UPDATE ... SET updated_at` and called it a claim,
    // but it changed no WHERE-predicate column so it never excluded a
    // concurrent tick's rows. Idempotency (in runReferralPreflight) +
    // pg-boss singleton scheduling provide the safety instead.
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: [{ id: "ref-1" }],
      error: null,
    });

    await runInboundReferralPreflightTick();

    expect(getSupabaseCallCount("inbound_referral_orders", "select")).toBe(1);
    expect(getSupabaseCallCount("inbound_referral_orders", "update")).toBe(0);
  });

  it("returns empty stats and runs nothing when no referrals need preflight", async () => {
    stageSupabaseResponse("inbound_referral_orders", "select", {
      data: [],
      error: null,
    });

    const stats = await runInboundReferralPreflightTick();

    expect(stats.scanned).toBe(0);
    expect(stats.completed).toBe(0);
    expect(runPreflightMock).not.toHaveBeenCalled();
  });
});
