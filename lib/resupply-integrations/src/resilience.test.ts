// Retry and circuit-breaking for therapy-cloud calls.
//
// The nightly sync walks a thousand links. The two failure modes this
// guards are opposite: too few retries drops a patient's data for a day,
// and naive retries turn a wrong client secret into three thousand
// rejected auth attempts and a vendor-side lockout.

import { describe, expect, it, vi } from "vitest";

import {
  IntegrationCircuitBreaker,
  backoffDelayMs,
  breakerKey,
  withRetries,
} from "./resilience";
import type { AdapterError } from "./errors";

type Result = { ok: boolean; error?: AdapterError };

/** Sleeps instantly and records what it was asked to wait. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe("backoffDelayMs", () => {
  it("draws from the whole interval, not just its end", () => {
    // Full jitter, because the herd is the problem: a thousand links
    // failing in lockstep and retrying at exactly 1s/2s/4s is a
    // thundering herd aimed at a vendor already struggling.
    expect(backoffDelayMs(0, { baseDelayMs: 1000, random: () => 0 })).toBe(0);
    expect(
      backoffDelayMs(0, { baseDelayMs: 1000, random: () => 0.999 }),
    ).toBeLessThan(1000);
  });

  it("doubles the ceiling each attempt", () => {
    const full = (attempt: number) =>
      backoffDelayMs(attempt, { baseDelayMs: 100, random: () => 0.9999 });
    expect(full(0)).toBeLessThan(100);
    expect(full(1)).toBeGreaterThanOrEqual(100);
    expect(full(1)).toBeLessThan(200);
    expect(full(3)).toBeLessThan(800);
  });

  it("respects the cap", () => {
    expect(
      backoffDelayMs(20, {
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        random: () => 0.9999,
      }),
    ).toBeLessThan(5000);
  });
});

describe("withRetries", () => {
  it("returns immediately on success", async () => {
    const op = vi.fn(async (): Promise<Result> => ({ ok: true }));
    const outcome = await withRetries(op, { sleep: async () => {} });
    expect(outcome.attempts).toBe(1);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and reports the attempt count", async () => {
    const op = vi
      .fn<(attempt: number) => Promise<Result>>()
      .mockResolvedValueOnce({ ok: false, error: "server_error" })
      .mockResolvedValueOnce({ ok: false, error: "timeout" })
      .mockResolvedValueOnce({ ok: true });
    const { sleep, waits } = fakeSleep();
    const outcome = await withRetries(op, {
      sleep,
      random: () => 0.5,
      baseDelayMs: 100,
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(waits).toHaveLength(2);
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });

  it("does NOT retry a bad credential", async () => {
    // The load-bearing test. Retrying this is how an account gets locked
    // out, turning a five-minute fix into a day of no data.
    const op = vi.fn(
      async (): Promise<Result> => ({ ok: false, error: "auth_failed" }),
    );
    const outcome = await withRetries(op, { sleep: async () => {} });
    expect(op).toHaveBeenCalledTimes(1);
    expect(outcome.attempts).toBe(1);
  });

  it.each([
    "forbidden",
    "endpoint_not_found",
    "bad_request",
    "mapping_failed",
  ] as const)("does NOT retry %s", async (error) => {
    const op = vi.fn(async (): Promise<Result> => ({ ok: false, error }));
    await withRetries(op, { sleep: async () => {} });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("does not retry a patient the vendor has never heard of", async () => {
    const op = vi.fn(
      async (): Promise<Result> => ({ ok: false, error: "not_found" }),
    );
    await withRetries(op, { sleep: async () => {} });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("stops at the attempt ceiling", async () => {
    const op = vi.fn(
      async (): Promise<Result> => ({ ok: false, error: "server_error" }),
    );
    const outcome = await withRetries(op, {
      maxAttempts: 4,
      sleep: async () => {},
      random: () => 0,
    });
    expect(op).toHaveBeenCalledTimes(4);
    expect(outcome.result.ok).toBe(false);
  });

  it("passes the attempt number to the operation", async () => {
    const seen: number[] = [];
    await withRetries(
      async (attempt) => {
        seen.push(attempt);
        return { ok: false, error: "timeout" as AdapterError };
      },
      { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
    );
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("IntegrationCircuitBreaker", () => {
  const KEY = breakerKey("resmed_airview", "org-1");

  function breakerAt(clock: { t: number }) {
    return new IntegrationCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => clock.t,
    });
  }

  it("starts closed", () => {
    const b = breakerAt({ t: 0 });
    expect(b.state(KEY)).toBe("closed");
    expect(b.canAttempt(KEY)).toBe(true);
  });

  it("opens at the failure threshold and blocks further calls", () => {
    const clock = { t: 0 };
    const b = breakerAt(clock);
    b.recordFailure(KEY, "server_error");
    b.recordFailure(KEY, "server_error");
    expect(b.canAttempt(KEY)).toBe(true);
    b.recordFailure(KEY, "server_error");
    expect(b.state(KEY)).toBe("open");
    expect(b.canAttempt(KEY)).toBe(false);
    expect(b.lastError(KEY)).toBe("server_error");
  });

  it("half-opens after the cool-down, allowing one probe", () => {
    const clock = { t: 0 };
    const b = breakerAt(clock);
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, "timeout");
    clock.t = 59_999;
    expect(b.canAttempt(KEY)).toBe(false);
    clock.t = 60_000;
    expect(b.state(KEY)).toBe("half_open");
    expect(b.canAttempt(KEY)).toBe(true);
  });

  it("closes on a successful probe — a recovered vendor returns without a deploy", () => {
    const clock = { t: 0 };
    const b = breakerAt(clock);
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, "timeout");
    clock.t = 60_000;
    b.recordSuccess(KEY);
    expect(b.state(KEY)).toBe("closed");
    expect(b.lastError(KEY)).toBeNull();
  });

  it("does NOT trip on a vendor that legitimately has no data", () => {
    // Five patients the vendor has never heard of is an empty roster,
    // not an outage. Tripping here would take down a working connector.
    const b = breakerAt({ t: 0 });
    for (let i = 0; i < 10; i++) b.recordNoData(KEY);
    expect(b.state(KEY)).toBe("closed");
  });

  it("keeps tenants independent — one org's bad secret is not another's", () => {
    const b = breakerAt({ t: 0 });
    const a = breakerKey("resmed_airview", "org-a");
    const other = breakerKey("resmed_airview", "org-b");
    for (let i = 0; i < 3; i++) b.recordFailure(a, "auth_failed");
    expect(b.canAttempt(a)).toBe(false);
    expect(b.canAttempt(other)).toBe(true);
  });

  it("keeps sources independent — one vendor down is not all of them", () => {
    const b = breakerAt({ t: 0 });
    const airview = breakerKey("resmed_airview", "org-1");
    const philips = breakerKey("philips_care", "org-1");
    for (let i = 0; i < 3; i++) b.recordFailure(airview, "server_error");
    expect(b.canAttempt(airview)).toBe(false);
    expect(b.canAttempt(philips)).toBe(true);
  });

  it("reports how long until a probe is allowed", () => {
    const clock = { t: 1000 };
    const b = breakerAt(clock);
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, "server_error");
    expect(b.retryAfterMs(KEY)).toBe(60_000);
    clock.t = 31_000;
    expect(b.retryAfterMs(KEY)).toBe(30_000);
    clock.t = 100_000;
    expect(b.retryAfterMs(KEY)).toBe(0);
  });

  it("can be reset for an operator-forced retry", () => {
    const b = breakerAt({ t: 0 });
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, "auth_failed");
    b.reset(KEY);
    expect(b.state(KEY)).toBe("closed");
  });
});
