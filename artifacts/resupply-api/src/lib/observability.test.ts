// Unit tests for the withMetrics wrapper (P3.9). Pin the
// behavioural contract that wrapping must NEVER alter the outcome
// (return value passthrough on success, error rethrow on failure)
// and the structural contract of the emitted event.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { logger } from "./logger";
import { withMetrics } from "./observability";

describe("withMetrics", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  function lastCallObj(): Record<string, unknown> {
    const calls = infoSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const arg = calls[calls.length - 1]![0];
    expect(arg).toBeTypeOf("object");
    return arg as Record<string, unknown>;
  }

  it("returns the fn's resolved value unchanged", async () => {
    const result = await withMetrics(
      { name: "test.success" },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it("emits a success event with the expected shape", async () => {
    await withMetrics({ name: "stripe.test_op" }, async () => "ok");
    const evt = lastCallObj();
    expect(evt.event).toBe("external_api_latency");
    expect(evt.name).toBe("stripe.test_op");
    expect(evt.outcome).toBe("success");
    expect(typeof evt.elapsed_ms).toBe("number");
    expect(evt.elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("rethrows the original error and emits outcome=failure", async () => {
    const sentinel = new Error("vendor-side boom");
    let caught: unknown = null;
    try {
      await withMetrics({ name: "twilio.boom" }, async () => {
        throw sentinel;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(sentinel);
    const evt = lastCallObj();
    expect(evt.event).toBe("external_api_latency");
    expect(evt.name).toBe("twilio.boom");
    expect(evt.outcome).toBe("failure");
  });

  it("flattens caller attrs into the event", async () => {
    await withMetrics(
      {
        name: "sendgrid.send_email",
        attrs: { vendor_endpoint: "us-west", idempotent: true },
      },
      async () => undefined,
    );
    const evt = lastCallObj();
    expect(evt.vendor_endpoint).toBe("us-west");
    expect(evt.idempotent).toBe(true);
  });

  it("does NOT log the thrown error — caller's job", async () => {
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      await withMetrics({ name: "x" }, async () => {
        throw new Error("nope");
      });
    } catch {
      // expected
    }
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("times measurably long calls", async () => {
    await withMetrics({ name: "slow" }, async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    const evt = lastCallObj();
    // ≥20ms accounts for setTimeout coarseness; the wrapper itself
    // adds < 1ms in steady state.
    expect(evt.elapsed_ms as number).toBeGreaterThanOrEqual(20);
  });
});
