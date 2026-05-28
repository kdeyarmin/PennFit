// Tests for the daily post-delivery follow-up sweep.
//
// Focus: the claim/release state machine and skip/fail counts. We do
// not assert SMS or caregiver fanout branches (best-effort, separately
// covered by their own helpers).
//
// Coverage:
//   * No candidates → considered=sent=0
//   * Happy path: customer with email → claim + send + sent+=1
//   * Lost claim race (no row updated) → skipped+=1
//   * Recipient lookup throws → claim released + failed+=1
//   * Send returns configured=false → claim released + skipped+=1
//   * Send returns delivered=false → claim released + failed+=1

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { sendDeliveryFollowupEmailMock } = vi.hoisted(() => ({
  sendDeliveryFollowupEmailMock: vi.fn(async () => ({
    configured: true,
    delivered: true,
    error: null,
  })),
}));
vi.mock("../../lib/order-emails/send-delivery-followup-email", () => ({
  sendDeliveryFollowupEmail: sendDeliveryFollowupEmailMock,
}));

vi.mock("../../lib/order-emails/send-caregiver-notification-email", () => ({
  sendCaregiverNotificationEmail: vi.fn(async () => undefined),
}));
vi.mock("../../lib/web-push", () => ({
  sendPushToCustomer: vi.fn(async () => undefined),
}));
vi.mock("../../lib/shop-orders-sms-resolver", () => ({
  resolveSmsRecipientForShopOrder: vi.fn(async () => null),
}));
vi.mock("@workspace/resupply-telecom", () => ({
  createTwilioSmsClient: vi.fn(() => ({
    sendSms: async () => ({ messageSid: "x" }),
  })),
  TwilioConfigError: class extends Error {},
}));

import { runDeliveryFollowupSweep } from "./shop-order-delivery-followup";

beforeEach(() => {
  supabaseMock.reset();
  sendDeliveryFollowupEmailMock.mockReset();
  sendDeliveryFollowupEmailMock.mockResolvedValue({
    configured: true,
    delivered: true,
    error: null,
  });
});

describe("runDeliveryFollowupSweep", () => {
  it("returns zeros when there are no candidates", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const stats = await runDeliveryFollowupSweep();
    expect(stats).toEqual({ considered: 0, sent: 0, skipped: 0, failed: 0 });
  });

  it("sends a follow-up on the happy path", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          customer_id: "cust_1",
          customer_email: "a@a.test",
          delivered_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // Atomic claim — returns the claimed row
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "ord_1",
        stripe_session_id: "cs_1",
        customer_id: "cust_1",
        customer_email: "a@a.test",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "a@a.test",
        display_name: "Alice Smith",
        caregiver_email: null,
        caregiver_name: null,
        caregiver_consent_at: null,
        caregiver_revoked_at: null,
      },
    });
    const stats = await runDeliveryFollowupSweep();
    expect(stats.considered).toBe(1);
    expect(stats.sent).toBe(1);
    expect(sendDeliveryFollowupEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "a@a.test",
        firstName: "Alice",
      }),
    );
  });

  it("counts as skipped when the claim returns no row (lost race)", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          customer_id: "cust_1",
          customer_email: "a@a.test",
          delivered_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // Lost the race — claim returns null
    stageSupabaseResponse("shop_orders", "update", { data: null });
    const stats = await runDeliveryFollowupSweep();
    expect(stats).toMatchObject({ considered: 1, skipped: 1, sent: 0 });
    expect(sendDeliveryFollowupEmailMock).not.toHaveBeenCalled();
  });

  it("releases claim and increments failed when recipient lookup throws", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          customer_id: "cust_1",
          customer_email: "a@a.test",
          delivered_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "ord_1",
        stripe_session_id: "cs_1",
        customer_id: "cust_1",
        customer_email: "a@a.test",
      },
    });
    // shop_customers lookup throws
    stageSupabaseResponse("shop_customers", "select", {
      error: { message: "db down" },
    });
    // Release claim update
    stageSupabaseResponse("shop_orders", "update", { data: null });
    const stats = await runDeliveryFollowupSweep();
    expect(stats).toMatchObject({ failed: 1 });
    expect(sendDeliveryFollowupEmailMock).not.toHaveBeenCalled();
  });

  it("releases claim and increments skipped when sender is unconfigured", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          customer_id: "cust_1",
          customer_email: "a@a.test",
          delivered_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "ord_1",
        stripe_session_id: "cs_1",
        customer_id: "cust_1",
        customer_email: "a@a.test",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "a@a.test",
        display_name: "Alice",
        caregiver_email: null,
        caregiver_name: null,
        caregiver_consent_at: null,
        caregiver_revoked_at: null,
      },
    });
    // Release claim
    stageSupabaseResponse("shop_orders", "update", { data: null });
    sendDeliveryFollowupEmailMock.mockResolvedValueOnce({
      configured: false,
      delivered: false,
      error: null,
    });
    const stats = await runDeliveryFollowupSweep();
    expect(stats).toMatchObject({ considered: 1, skipped: 1, sent: 0 });
  });

  it("releases claim and increments failed when delivery fails", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          customer_id: "cust_1",
          customer_email: "a@a.test",
          delivered_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "ord_1",
        stripe_session_id: "cs_1",
        customer_id: "cust_1",
        customer_email: "a@a.test",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "a@a.test",
        display_name: "Alice",
        caregiver_email: null,
        caregiver_name: null,
        caregiver_consent_at: null,
        caregiver_revoked_at: null,
      },
    });
    // Release claim
    stageSupabaseResponse("shop_orders", "update", { data: null });
    sendDeliveryFollowupEmailMock.mockResolvedValueOnce({
      configured: true,
      delivered: false,
      error: "smtp_5xx",
    });
    const stats = await runDeliveryFollowupSweep();
    expect(stats).toMatchObject({ considered: 1, failed: 1, sent: 0 });
  });
});
