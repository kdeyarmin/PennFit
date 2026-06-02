import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMAIL_RETRY_POLICY,
  computeBackoffMs,
  isTransientSendgridError,
  withRetry,
} from "./retry";

describe("isTransientSendgridError", () => {
  it("retries HTTP 429 (rate limited)", () => {
    expect(isTransientSendgridError({ response: { statusCode: 429 } })).toBe(
      true,
    );
  });

  it("retries HTTP 5xx (server error)", () => {
    expect(isTransientSendgridError({ response: { statusCode: 503 } })).toBe(
      true,
    );
    expect(isTransientSendgridError({ response: { statusCode: 500 } })).toBe(
      true,
    );
  });

  it("does NOT retry HTTP 4xx other than 429", () => {
    expect(isTransientSendgridError({ response: { statusCode: 400 } })).toBe(
      false,
    );
    expect(isTransientSendgridError({ response: { statusCode: 401 } })).toBe(
      false,
    );
    expect(isTransientSendgridError({ response: { statusCode: 403 } })).toBe(
      false,
    );
  });

  it("retries recognised transport-layer error codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(isTransientSendgridError({ code })).toBe(true);
    }
  });

  it("retries network failures surfaced only via message", () => {
    expect(isTransientSendgridError({ message: "fetch failed" })).toBe(true);
    expect(isTransientSendgridError({ message: "socket hang up" })).toBe(true);
  });

  it("does NOT retry unknown/odd shapes", () => {
    expect(isTransientSendgridError(null)).toBe(false);
    expect(isTransientSendgridError("boom")).toBe(false);
    expect(isTransientSendgridError({ message: "validation failed" })).toBe(
      false,
    );
    expect(isTransientSendgridError({ code: "EWHATEVER" })).toBe(false);
  });

  it("treats a numeric `code` as an HTTP status", () => {
    expect(isTransientSendgridError({ code: 502 })).toBe(true);
    expect(isTransientSendgridError({ code: 400 })).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  it("never exceeds the cap and grows with attempt", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ms = computeBackoffMs(attempt, policy);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });

  it("default policy is bounded and short", () => {
    expect(DEFAULT_EMAIL_RETRY_POLICY.maxAttempts).toBe(3);
    expect(DEFAULT_EMAIL_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(2000);
  });
});

describe("withRetry", () => {
  const policy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
  const noSleep = () => Promise.resolve();

  it("returns the first successful result without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn(noSleep);
    const out = await withRetry(fn, policy, {
      shouldRetry: () => true,
      sleep,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries until success then resolves", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const out = await withRetry(fn, policy, {
      shouldRetry: () => true,
      sleep: noSleep,
      onRetry,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("stops at maxAttempts and rethrows the last error", async () => {
    const err = new Error("always");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, policy, { shouldRetry: () => true, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry is false", async () => {
    const err = new Error("terminal");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, policy, { shouldRetry: () => false, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxAttempts:1 disables retry", async () => {
    const err = new Error("terminal");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(
        fn,
        { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        { shouldRetry: () => true, sleep: noSleep },
      ),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
