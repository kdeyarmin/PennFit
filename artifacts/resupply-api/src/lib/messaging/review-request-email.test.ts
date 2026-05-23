// Tests for sendReviewRequestEmail — feature flag gate behavior.
//
// Coverage:
//   1. Returns {sent: false, reason: "feature_disabled"} when the
//      storefront.reviews_collection feature flag is off.
//   2. Proceeds to the SendGrid call when the flag is on.
//   3. Returns {sent: false, reason: "email_not_configured"} when the
//      flag is on but no SendGrid client is available.
//   4. Returns {sent: true, messageId} when the flag is on and the
//      client sends successfully.
//   5. Returns {sent: false, reason: <error message>} when the client
//      throws.
//   6. Feature-disabled path is independent of the clientFactory arg —
//      the factory is never invoked when the gate fires.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock isFeatureEnabled (must be hoisted before SUT import) ─────────────

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// Suppress readPracticeName side effects (env read)
vi.mock("./messaging-config", () => ({
  readPracticeName: vi.fn(() => "PennPaps"),
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import {
  sendReviewRequestEmail,
  type ReviewRequestEmailInput,
} from "./review-request-email";

// ─── Helpers ──────────────────────────────────────────────────────────────

function sampleInput(): ReviewRequestEmailInput {
  return {
    to: "patient@example.com",
    productName: "AirFit F30i",
    productUrl: "https://pennpaps.example.com/shop/p/airfit-f30i?review=1",
  };
}

function makeClient(
  opts: { throws?: Error; messageId?: string } = {},
): { sendEmail: ReturnType<typeof vi.fn> } {
  return {
    sendEmail: opts.throws
      ? vi.fn().mockRejectedValue(opts.throws)
      : vi.fn().mockResolvedValue({ messageId: opts.messageId ?? "msg-abc" }),
  };
}

beforeEach(() => {
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
});

// ─── Feature flag gate ────────────────────────────────────────────────────

describe("sendReviewRequestEmail — feature flag gate", () => {
  it("returns feature_disabled when storefront.reviews_collection is off", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const result = await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => makeClient() as never,
    });

    expect(result).toEqual({ sent: false, reason: "feature_disabled" });
  });

  it("does not invoke the clientFactory when the feature is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const factorySpy = vi.fn(() => makeClient() as never);

    await sendReviewRequestEmail(sampleInput(), {
      clientFactory: factorySpy,
    });

    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("calls isFeatureEnabled with the correct flag key", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => null,
    });

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "storefront.reviews_collection",
    );
  });
});

// ─── Normal operation (feature enabled) ──────────────────────────────────

describe("sendReviewRequestEmail — normal paths (feature enabled)", () => {
  it("returns email_not_configured when clientFactory returns null", async () => {
    const result = await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => null,
    });

    expect(result).toEqual({ sent: false, reason: "email_not_configured" });
  });

  it("returns {sent: true, messageId} on a successful send", async () => {
    const client = makeClient({ messageId: "msg-xyz" });

    const result = await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => client as never,
    });

    expect(result).toEqual({ sent: true, messageId: "msg-xyz" });
  });

  it("passes the correct to, subject, html, and text to sendEmail", async () => {
    const client = makeClient();

    await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => client as never,
    });

    expect(client.sendEmail).toHaveBeenCalledOnce();
    const call = client.sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(call.to).toBe("patient@example.com");
    expect(call.subject).toContain("AirFit F30i");
    expect(call.html).toContain("Leave a review");
    expect(call.text).toContain("Leave a review");
  });

  it("returns {sent: false, reason: <message>} when sendEmail throws an Error", async () => {
    const client = makeClient({ throws: new Error("550 user not found") });

    const result = await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => client as never,
    });

    expect(result).toEqual({ sent: false, reason: "550 user not found" });
  });

  it("returns {sent: false, reason: 'send_failed'} when sendEmail throws a non-Error", async () => {
    const client = {
      sendEmail: vi.fn().mockRejectedValue("plain string throw"),
    };

    const result = await sendReviewRequestEmail(sampleInput(), {
      clientFactory: () => client as never,
    });

    expect(result).toEqual({ sent: false, reason: "send_failed" });
  });
});