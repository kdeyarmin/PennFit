// Unit tests for the server-side web-push helper (Phase G.1).
//
// We stub the `web-push` SDK and the drizzle adapter so the test
// stays in-process. The contract under test:
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

const updateCalls: { id: string; expiredAt: Date | null }[] = [];
const selectRows: {
  id: string;
  endpoint: string;
  authB64: string;
  p256dhB64: string;
}[] = [];
// selectQueue allows tests that need ordered multi-query behavior
// (e.g. sendPushToCustomerByEmail makes two selects: one for
// shopCustomers, one for shopCustomerPushSubscriptions). When
// non-empty the queue items are shifted off in call order; once
// exhausted, calls fall through to the shared selectRows array.
const selectQueue: unknown[][] = [];

const dbStub = {
  select: vi.fn(() => {
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => {
        if (selectQueue.length > 0) return Promise.resolve(selectQueue.shift());
        return Promise.resolve(selectRows);
      },
    };
    return obj;
  }),
  update: vi.fn(() => {
    let captured: { expiredAt: Date | null } = { expiredAt: null };
    const obj: Record<string, unknown> = {
      set: (vals: { expiredAt: Date | null }) => {
        captured = vals;
        return obj;
      },
      where: (cond: { _id?: string }) => {
        // The mock can't really inspect drizzle's eq() expression,
        // so we accept whatever id was last requested. Tests that
        // care about the id assert on updateCalls.length only.
        updateCalls.push({
          id: cond._id ?? "?",
          expiredAt: captured.expiredAt,
        });
        return Promise.resolve();
      },
    };
    return obj;
  }),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  selectRows.length = 0;
  selectQueue.length = 0;
  updateCalls.length = 0;
  dbStub.select.mockClear();
  dbStub.update.mockClear();
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
    selectRows.push(
      {
        id: "s1",
        endpoint: "https://push.x/1",
        authB64: "a1",
        p256dhB64: "p1",
      },
      {
        id: "s2",
        endpoint: "https://push.x/2",
        authB64: "a2",
        p256dhB64: "p2",
      },
    );
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
    selectRows.push({
      id: "s_dead",
      endpoint: "https://push.x/dead",
      authB64: "a",
      p256dhB64: "p",
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
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]?.expiredAt).toBeInstanceOf(Date);
  });

  it("marks rows expired on 410", async () => {
    setVapidEnv();
    selectRows.push({
      id: "s_gone",
      endpoint: "https://push.x/gone",
      authB64: "a",
      p256dhB64: "p",
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
    expect(updateCalls.length).toBe(1);
  });

  it("counts non-expiring failures as transient and does not mark expired", async () => {
    setVapidEnv();
    selectRows.push({
      id: "s_err",
      endpoint: "https://push.x/err",
      authB64: "a",
      p256dhB64: "p",
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
    expect(updateCalls.length).toBe(0);
  });

  it("mixes outcomes within a single fan-out", async () => {
    setVapidEnv();
    selectRows.push(
      { id: "ok", endpoint: "https://push.x/ok", authB64: "a", p256dhB64: "p" },
      { id: "g", endpoint: "https://push.x/g", authB64: "a", p256dhB64: "p" },
      { id: "t", endpoint: "https://push.x/t", authB64: "a", p256dhB64: "p" },
    );
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
    expect(updateCalls.length).toBe(1);
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
    // DB should never be queried when push is disabled.
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("returns {0,0,0} and skips delivery when email_lower is ambiguous", async () => {
    setVapidEnv();
    const sdk = makeSdkStub({ behavior: () => Promise.resolve() });
    __setSdkForTesting(sdk);

    // Two shop_customers rows share the same email_lower → ambiguous.
    selectQueue.push([
      { customerId: "cust_a" },
      { customerId: "cust_b" },
    ]);

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
    selectQueue.push([]);

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

    // First select: 1 shopCustomers row.
    selectQueue.push([{ customerId: "cust_a" }]);
    // Second select (sendPushToCustomer): 1 subscription row.
    selectQueue.push([
      {
        id: "sub_1",
        endpoint: "https://push.example.com/1",
        authB64: "auth",
        p256dhB64: "p256dh",
      },
    ]);

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
