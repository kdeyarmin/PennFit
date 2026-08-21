// sendRefundNotificationIfNew — atomic-claim + recipient resolution.
//
// supabase is mocked to control the claim (the UPDATE ... RETURNING) and
// the shop_customers lookup; the email builder is mocked at its boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn();
vi.mock("./send-refund-notification-email", () => ({
  sendRefundNotificationEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

// Push is best-effort; stub it so a missing VAPID config doesn't matter.
vi.mock("../web-push", () => ({
  sendPushToCustomer: vi.fn(async () => ({
    delivered: 0,
    expired: 0,
    transient: 0,
  })),
}));

vi.mock("../tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: "Penn Home Medical Supply",
    legalName: "Penn Home Medical Supply",
    tagline: "t",
    logoUrl: null,
  })),
}));

import { sendRefundNotificationIfNew } from "./refund-notification";

const ORG = "11111111-1111-4111-8111-111111111111";

function baseArgs() {
  return {
    orgId: ORG,
    orderId: "order_1",
    amountRefundedCents: 4999,
    currency: "usd",
    isPartial: false,
    log: undefined,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  sendEmailMock.mockReset();
});

describe("sendRefundNotificationIfNew", () => {
  it("claims, resolves the recipient, and sends", async () => {
    // Claim UPDATE ... RETURNING wins (row returned).
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "order_1",
        stripe_session_id: "cs_1",
        customer_id: "cust_1",
        customer_email: null,
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    sendEmailMock.mockResolvedValue({ configured: true, delivered: true });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: false, delivered: true });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "buyer@example.com",
        stripeSessionId: "cs_1",
        amountRefundedCents: 4999,
        isPartial: false,
        orgId: ORG,
      }),
    );
  });

  it("skips when the claim is already taken (returns flow stamped it)", async () => {
    // Claim UPDATE matches no row → maybeSingle returns null.
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: true, reason: "already_sent_or_missing" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("fails soft (never throws) when the claim query itself errors", async () => {
    // The claim UPDATE errors (DB hiccup). Since this runs on the
    // charge.refunded webhook path, the helper must NOT throw and must not
    // send — it honors its "NEVER throws" contract by returning skipped.
    stageSupabaseResponse("shop_orders", "update", {
      error: { message: "db unavailable" },
    });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: true, reason: "claim_failed" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("falls back to the guest customer_email when no linked customer", async () => {
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "order_1",
        stripe_session_id: "cs_1",
        customer_id: null,
        customer_email: "guest@example.com",
      },
    });
    sendEmailMock.mockResolvedValue({ configured: true, delivered: true });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: false, delivered: true });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "guest@example.com" }),
    );
  });

  it("releases the claim and skips when there is no recipient", async () => {
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "order_1",
        stripe_session_id: "cs_1",
        customer_id: null,
        customer_email: null,
      },
    });
    // Release UPDATE (no RETURNING usage asserted).
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: true, reason: "no_email_on_file" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("releases the claim when SendGrid is unconfigured", async () => {
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: "order_1",
        stripe_session_id: "cs_1",
        customer_id: null,
        customer_email: "guest@example.com",
      },
    });
    stageSupabaseResponse("shop_orders", "update", { data: null });
    sendEmailMock.mockResolvedValue({ configured: false, delivered: false });

    const r = await sendRefundNotificationIfNew(baseArgs());
    expect(r).toEqual({ skipped: true, reason: "not_configured" });
  });
});
