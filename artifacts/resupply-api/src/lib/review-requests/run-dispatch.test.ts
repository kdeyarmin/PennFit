import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../feature-flags", () => ({ isFeatureEnabled: isFeatureEnabledMock }));

const sendReviewRequestEmailMock = vi.hoisted(() =>
  vi.fn(async () => ({ sent: true as const })),
);
vi.mock("../messaging/review-request-email", () => ({
  sendReviewRequestEmail: sendReviewRequestEmailMock,
}));

import { runReviewRequestDispatch } from "./run-dispatch";

const ORG = "00000000-0000-4000-8000-000000000000";

beforeEach(() => {
  supabaseMock.reset();
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
  sendReviewRequestEmailMock.mockClear();
  sendReviewRequestEmailMock.mockResolvedValue({ sent: true });
});

describe("runReviewRequestDispatch", () => {
  it("no-ops (zeros) when reviews collection is off for the tenant", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const stats = await runReviewRequestDispatch({ orgId: ORG });
    expect(stats).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
    });
    expect(supabaseMock.callCount("shop_orders", "select")).toBe(0);
    expect(sendReviewRequestEmailMock).not.toHaveBeenCalled();
  });

  it("sends a review request for an eligible, opted-in order", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: "o1", customer_id: "c1" }],
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: [{ id: "o1", customer_id: "c1" }],
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        {
          customer_id: "c1",
          email_lower: "pat@example.com",
          communication_preferences: { emailReviewRequests: true },
        },
      ],
    });
    stageSupabaseResponse("shop_order_items", "select", {
      data: [{ order_id: "o1", product_id: "prod_x" }],
    });

    const stats = await runReviewRequestDispatch({ orgId: ORG });
    expect(stats.scanned).toBe(1);
    expect(stats.sent).toBe(1);
    expect(sendReviewRequestEmailMock).toHaveBeenCalledTimes(1);
    expect(sendReviewRequestEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "pat@example.com", orgId: ORG }),
    );
  });

  it("skips (and unclaims) an order whose customer opted out of review emails", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: "o1", customer_id: "c1" }],
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: [{ id: "o1", customer_id: "c1" }],
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        {
          customer_id: "c1",
          email_lower: "pat@example.com",
          communication_preferences: { emailReviewRequests: false },
        },
      ],
    });
    stageSupabaseResponse("shop_order_items", "select", {
      data: [{ order_id: "o1", product_id: "prod_x" }],
    });
    // the unclaim UPDATE
    stageSupabaseResponse("shop_orders", "update", { data: [{ id: "o1" }] });

    const stats = await runReviewRequestDispatch({ orgId: ORG });
    expect(stats.skippedOptOut).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendReviewRequestEmailMock).not.toHaveBeenCalled();
  });

  it("zeros when there are no eligible orders", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const stats = await runReviewRequestDispatch({ orgId: ORG });
    expect(stats.scanned).toBe(0);
    expect(sendReviewRequestEmailMock).not.toHaveBeenCalled();
  });
});
