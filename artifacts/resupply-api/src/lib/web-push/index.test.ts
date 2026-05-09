// Unit tests for the server-side web-push helper (Phase G.1).
//
// Stubs the `web-push` SDK and the Supabase service-role client so
// the test stays in-process. The contract under test:
//
//   * No env triple → caller gets {0,0,0} and the SDK is never asked
//     for a delivery.
//   * Each subscription row is delivered to the SDK as a discrete
//     send call.
//   * 404 / 410 mark the row expired and bump the `expired` counter.
//   * Anything else bumps `transient` and leaves the row alone.
//   * sendPushToCustomerByEmail: ambiguous email_lower → {0,0,0}
//
// Note: this suite exercises delivery/result handling only. It does
// not currently assert log redaction for transient-path logging.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  __setSdkForTesting,
  isPushConfigured,
  readPushConfig,
  sendPushToCustomer,
  sendPushToCustomerByEmail,
  type WebPushSdk,
} from "./index";

const ORIGINAL_ENV = { ...process.env };

function setVapidEnv() {
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "BKxxPubKey";
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "PrivKey";
  process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:ops@pennpaps.com";
}

beforeEach(() => {
  supabaseMock.reset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __setSdkForTesting(null);
});

describe("readPushConfig / isPushConfigured", () => {
  it("returns null when any env var is missing", () => {
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_VAPID_SUBJECT;
    expect(readPushConfig()).toBeNull();
    expect(isPushConfigured()).toBe(false);
  });

  it("returns the triple when all three are set", () => {
    setVapidEnv();
    expect(isPushConfigured()).toBe(true);
    expect(readPushConfig()).toEqual({
      publicKey: "BKxxPubKey",
      privateKey: "PrivKey",
      subject: "mailto:ops@pennpaps.com",
    });
  });
});

describe("sendPushToCustomer", () => {
  it("no-ops when push is not configured", async () => {
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);
    const result = await sendPushToCustomer("cust_a", {
      title: "Hi",
      body: "There",
    });
    expect(result).toEqual({ delivered: 0, expired: 0, transient: 0 });
    expect(sdk.sendNotification).not.toHaveBeenCalled();
  });

  it("returns zero counts when no subscriptions match", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [],
    });
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);
    const result = await sendPushToCustomer("cust_a", {
      title: "Hi",
      body: "There",
    });
    expect(result).toEqual({ delivered: 0, expired: 0, transient: 0 });
    expect(sdk.sendNotification).not.toHaveBeenCalled();
  });

  it("delivers to every active subscription and counts successes", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "s1",
          endpoint: "https://push.x/1",
          auth_b64: "a1",
          p256dh_b64: "p1",
        },
        {
          id: "s2",
          endpoint: "https://push.x/2",
          auth_b64: "a2",
          p256dh_b64: "p2",
        },
      ],
    });
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);

    const result = await sendPushToCustomer("cust_a", {
      title: "Order shipped",
      body: "Mask + tubing on the way.",
      url: "/account/orders/abc",
    });

    expect(result).toEqual({ delivered: 2, expired: 0, transient: 0 });
    expect(sdk.sendNotification).toHaveBeenCalledTimes(2);
    expect(sdk.setVapidDetails).toHaveBeenCalledWith(
      "mailto:ops@pennpaps.com",
      "BKxxPubKey",
      "PrivKey",
    );
    // Payload is JSON-serialized, with the deep link forwarded.
    const payload = sdk.sendNotification.mock.calls[0]?.[1] as string;
    expect(JSON.parse(payload)).toEqual({
      title: "Order shipped",
      body: "Mask + tubing on the way.",
      url: "/account/orders/abc",
      tag: null,
    });
  });

  it("marks rows expired on 404", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "s_dead",
          endpoint: "https://push.x/dead",
          auth_b64: "a",
          p256dh_b64: "p",
        },
      ],
    });
    stageSupabaseResponse("shop_customer_push_subscriptions", "update", {
      error: null,
    });
    const sdk = makeSdkStub({
      behavior: () => Promise.reject(makeWebPushError(404)),
    });
    __setSdkForTesting(sdk);

    const result = await sendPushToCustomer("cust_a", {
      title: "x",
      body: "y",
    });
    expect(result).toEqual({ delivered: 0, expired: 1, transient: 0 });
    expect(getSupabaseCallCount("shop_customer_push_subscriptions", "update"))
      .toBe(1);
  });

  it("marks rows expired on 410", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "s_gone",
          endpoint: "https://push.x/gone",
          auth_b64: "a",
          p256dh_b64: "p",
        },
      ],
    });
    stageSupabaseResponse("shop_customer_push_subscriptions", "update", {
      error: null,
    });
    const sdk = makeSdkStub({
      behavior: () => Promise.reject(makeWebPushError(410)),
    });
    __setSdkForTesting(sdk);

    const result = await sendPushToCustomer("cust_a", {
      title: "x",
      body: "y",
    });
    expect(result).toEqual({ delivered: 0, expired: 1, transient: 0 });
    expect(getSupabaseCallCount("shop_customer_push_subscriptions", "update"))
      .toBe(1);
  });

  it("counts non-expiring failures as transient and does not mark expired", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "s_err",
          endpoint: "https://push.x/err",
          auth_b64: "a",
          p256dh_b64: "p",
        },
      ],
    });
    const sdk = makeSdkStub({
      behavior: () => Promise.reject(makeWebPushError(429)),
    });
    __setSdkForTesting(sdk);

    const result = await sendPushToCustomer("cust_a", {
      title: "x",
      body: "y",
    });
    expect(result).toEqual({ delivered: 0, expired: 0, transient: 1 });
    expect(getSupabaseCallCount("shop_customer_push_subscriptions", "update"))
      .toBe(0);
  });

  it("mixes outcomes within a single fan-out", async () => {
    setVapidEnv();
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        { id: "ok", endpoint: "https://push.x/ok", auth_b64: "a", p256dh_b64: "p" },
        { id: "g", endpoint: "https://push.x/g", auth_b64: "a", p256dh_b64: "p" },
        { id: "t", endpoint: "https://push.x/t", auth_b64: "a", p256dh_b64: "p" },
      ],
    });
    // Only the 410 row triggers an UPDATE (markExpired).
    stageSupabaseResponse("shop_customer_push_subscriptions", "update", {
      error: null,
    });
    const sdk: WebPushSdk = {
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(async (sub) => {
        if (sub.endpoint === "https://push.x/g") throw makeWebPushError(410);
        if (sub.endpoint === "https://push.x/t") throw makeWebPushError(500);
      }),
    };
    __setSdkForTesting(sdk);

    const result = await sendPushToCustomer("cust_a", {
      title: "x",
      body: "y",
    });
    expect(result).toEqual({ delivered: 1, expired: 1, transient: 1 });
    expect(getSupabaseCallCount("shop_customer_push_subscriptions", "update"))
      .toBe(1);
  });
});

describe("sendPushToCustomerByEmail", () => {
  it("returns {0,0,0} when VAPID is not configured", async () => {
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const result = await sendPushToCustomerByEmail("user@example.com", {
      title: "Test",
      body: "Body",
    });
    expect(result).toEqual({ delivered: 0, expired: 0, transient: 0 });
    // Push being disabled means we never hit the DB at all.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("returns {0,0,0} and skips delivery when email_lower is ambiguous", async () => {
    setVapidEnv();
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);

    // Two shop_customers rows share the same email_lower → ambiguous.
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        { customer_id: "cust_a" },
        { customer_id: "cust_b" },
      ],
    });

    const result = await sendPushToCustomerByEmail("shared@example.com", {
      title: "Rx reminder",
      body: "Tap to renew.",
      tag: "rx_renewal:rx_1",
    });

    expect(result).toEqual({ delivered: 0, expired: 0, transient: 0 });
    // Push SDK must never be called when lookup is ambiguous.
    expect(sdk.sendNotification).not.toHaveBeenCalled();
  });

  it("returns {0,0,0} when no shop_customers row matches", async () => {
    setVapidEnv();
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);

    // Empty customer lookup result.
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    const result = await sendPushToCustomerByEmail("nobody@example.com", {
      title: "Test",
      body: "Body",
    });

    expect(result).toEqual({ delivered: 0, expired: 0, transient: 0 });
    expect(sdk.sendNotification).not.toHaveBeenCalled();
  });

  it("fans out to the resolved customer when exactly 1 match", async () => {
    setVapidEnv();
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);

    // First select: 1 shop_customers row.
    stageSupabaseResponse("shop_customers", "select", {
      data: [{ customer_id: "cust_a" }],
    });
    // Second select (sendPushToCustomer): 1 subscription row.
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "sub_1",
          endpoint: "https://push.example.com/1",
          auth_b64: "auth",
          p256dh_b64: "p256dh",
        },
      ],
    });

    const result = await sendPushToCustomerByEmail("patient@example.com", {
      title: "Rx expires in 5 days",
      body: "Tap to coordinate a renewal.",
      url: "/account",
      tag: "rx_renewal:rx_1",
    });

    expect(result).toEqual({ delivered: 1, expired: 0, transient: 0 });
    expect(sdk.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      sdk.sendNotification.mock.calls[0]?.[1] as string,
    );
    expect(payload.tag).toBe("rx_renewal:rx_1");
    expect(payload.url).toBe("/account");
  });
});

function makeSdkStub(opts: {
  behavior: (
    sub: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: string,
  ) => Promise<unknown>;
}): WebPushSdk & {
  setVapidDetails: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
} {
  return {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(opts.behavior),
  };
}

function makeWebPushError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}
