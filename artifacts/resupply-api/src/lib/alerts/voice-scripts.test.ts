import { describe, it, expect } from "vitest";

import { AlertVoiceScripts } from "./voice-scripts";

describe("AlertVoiceScripts", () => {
  it("registers and claims a script exactly once", () => {
    const store = new AlertVoiceScripts({ sweepIntervalMs: 0 });
    store.register("ref-1", "Hello there");
    expect(store.peek("ref-1")?.spokenText).toBe("Hello there");
    const claimed = store.claim("ref-1");
    expect(claimed?.spokenText).toBe("Hello there");
    // Consumed — a second claim misses.
    expect(store.claim("ref-1")).toBeNull();
    store.shutdown();
  });

  it("expires entries past the TTL", () => {
    let now = 1_000;
    const store = new AlertVoiceScripts({
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => now,
    });
    store.register("ref-2", "expiring");
    now = 1_201;
    expect(store.peek("ref-2")).toBeNull();
    expect(store.size()).toBe(0);
    store.shutdown();
  });

  it("returns null for an unknown ref", () => {
    const store = new AlertVoiceScripts({ sweepIntervalMs: 0 });
    expect(store.claim("nope")).toBeNull();
    store.shutdown();
  });
});
