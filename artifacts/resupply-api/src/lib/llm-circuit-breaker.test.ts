import { describe, expect, it } from "vitest";

import {
  CircuitBreaker,
  getLlmBreaker,
  __resetLlmBreakersForTests,
} from "./llm-circuit-breaker";

// A controllable clock so we can advance time deterministically.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  it("stays closed and allows attempts below the failure threshold", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, now: clock.now });
    expect(b.state).toBe("closed");
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("closed");
    expect(b.canAttempt()).toBe(true);
  });

  it("opens after N consecutive failures and short-circuits attempts", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: clock.now,
    });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.canAttempt()).toBe(false);
  });

  it("a success resets the consecutive-failure count", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, now: clock.now });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    // Only 2 in a row since the success — still closed.
    expect(b.state).toBe("closed");
  });

  it("transitions to half-open after the cooldown and allows exactly one trial", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 30_000,
      now: clock.now,
    });
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.canAttempt()).toBe(false);

    clock.advance(30_000);
    expect(b.state).toBe("half-open");
    // First caller gets the trial...
    expect(b.canAttempt()).toBe(true);
    // ...concurrent callers are short-circuited until it resolves.
    expect(b.canAttempt()).toBe(false);
  });

  it("a successful half-open trial closes the breaker", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 30_000,
      now: clock.now,
    });
    b.recordFailure();
    b.recordFailure();
    clock.advance(30_000);
    expect(b.canAttempt()).toBe(true); // trial
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.canAttempt()).toBe(true);
  });

  it("a failed half-open trial re-opens for another cooldown", () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 30_000,
      now: clock.now,
    });
    b.recordFailure();
    b.recordFailure();
    clock.advance(30_000);
    expect(b.canAttempt()).toBe(true); // trial
    b.recordFailure(); // trial fails
    expect(b.state).toBe("open");
    expect(b.canAttempt()).toBe(false);
    // ...and reopens for a fresh cooldown window.
    clock.advance(29_999);
    expect(b.state).toBe("open");
    clock.advance(1);
    expect(b.state).toBe("half-open");
  });
});

describe("getLlmBreaker", () => {
  it("returns the same instance per vendor key and isolates vendors", () => {
    __resetLlmBreakersForTests();
    const a1 = getLlmBreaker("openai");
    const a2 = getLlmBreaker("openai");
    const b1 = getLlmBreaker("anthropic");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });
});
