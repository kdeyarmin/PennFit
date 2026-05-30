import { describe, expect, it, vi } from "vitest";

import { withRetry } from "./with-retry";

describe("withRetry", () => {
  it("returns the value on first success without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { sleep, attempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries until success and sleeps between attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const result = await withRetry(fn, { sleep, attempts: 5, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // Two retries — two sleeps.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws after `attempts` exhausted", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(
      withRetry(fn, { sleep, attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-retriable errors immediately", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error("4xx");
    });
    await expect(
      withRetry(fn, {
        sleep,
        attempts: 5,
        isRetriable: (err) => err instanceof Error && /^5/.test(err.message),
      }),
    ).rejects.toThrow("4xx");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("invokes onRetry callback with attempt number and delay", async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new Error("retry me");
      return "ok";
    };
    await withRetry(fn, { sleep, attempts: 3, onRetry, baseDelayMs: 1 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, err, delay] = onRetry.mock.calls[0]!;
    expect(attempt).toBe(1);
    expect((err as Error).message).toBe("retry me");
    expect(typeof delay).toBe("number");
  });

  it("caps the backoff at maxDelayMs", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const fn = async () => {
      throw new Error("persistent");
    };
    await expect(
      withRetry(fn, {
        sleep,
        attempts: 6,
        baseDelayMs: 100,
        maxDelayMs: 250,
      }),
    ).rejects.toThrow();
    // Backoff (excluding jitter) caps at 250 — every recorded sleep
    // must be <= 250 + baseDelayMs (the jitter cap).
    for (const s of sleeps) {
      expect(s).toBeLessThanOrEqual(250 + 100);
    }
  });
});
