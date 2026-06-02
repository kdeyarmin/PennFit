import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SMS_RETRY_POLICY,
  computeBackoffMs,
  isTransientTwilioError,
  withRetry,
} from "./retry";

describe("isTransientTwilioError", () => {
  it("retries HTTP 429 / 5xx (status field)", () => {
    expect(isTransientTwilioError({ status: 429 })).toBe(true);
    expect(isTransientTwilioError({ status: 500 })).toBe(true);
    expect(isTransientTwilioError({ status: 503 })).toBe(true);
  });

  it("does NOT retry Twilio business-logic 4xx", () => {
    // 21610 = "blocked by recipient" — terminal, must not retry.
    expect(isTransientTwilioError({ status: 400, code: 21610 })).toBe(false);
    expect(isTransientTwilioError({ status: 401, code: 20003 })).toBe(false);
    expect(isTransientTwilioError({ status: 404 })).toBe(false);
  });

  it("does NOT treat the Twilio error `code` as an HTTP status", () => {
    // A numeric Twilio error code (21610) with NO http status must not
    // be misread as a 5xx-ish value and retried.
    expect(isTransientTwilioError({ code: 21610 })).toBe(false);
  });

  it("retries recognised transport-layer error codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(isTransientTwilioError({ code })).toBe(true);
    }
  });

  it("retries network failures surfaced only via message", () => {
    expect(isTransientTwilioError({ message: "fetch failed" })).toBe(true);
    expect(isTransientTwilioError({ message: "socket hang up" })).toBe(true);
  });

  it("does NOT retry unknown/odd shapes", () => {
    expect(isTransientTwilioError(null)).toBe(false);
    expect(isTransientTwilioError("boom")).toBe(false);
    expect(isTransientTwilioError({ message: "invalid 'To' number" })).toBe(
      false,
    );
  });
});

describe("computeBackoffMs", () => {
  it("stays within the cap", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ms = computeBackoffMs(attempt, policy);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });

  it("default policy is bounded", () => {
    expect(DEFAULT_SMS_RETRY_POLICY.maxAttempts).toBe(3);
    expect(DEFAULT_SMS_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(2000);
  });
});

describe("withRetry", () => {
  const policy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
  const noSleep = () => Promise.resolve();

  it("returns first success without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn(noSleep);
    await expect(
      withRetry(fn, policy, { shouldRetry: () => true, sleep }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries to success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue("ok");
    await expect(
      withRetry(fn, policy, { shouldRetry: () => true, sleep: noSleep }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows last error at maxAttempts", async () => {
    const err = new Error("always");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, policy, { shouldRetry: () => true, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry terminal errors", async () => {
    const err = new Error("terminal");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, policy, { shouldRetry: () => false, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
