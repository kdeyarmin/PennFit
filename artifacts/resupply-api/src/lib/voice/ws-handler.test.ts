// Tests for ws-handler.ts
//
// PR change: ring-buffer semantics for transcript turn history.
//
// Previously both `deepgramTurns` and `turnHistory` used a "push only
// if below cap" strategy:
//
//   if (deepgramTurns.length < MAX_RETAINED_TURNS) {
//     deepgramTurns.push(text);
//   }
//
// This means that once the cap was reached every new turn was silently
// dropped. The PR replaces this with a proper ring buffer that shifts
// the oldest entry before pushing:
//
//   if (deepgramTurns.length >= MAX_RETAINED_TURNS) {
//     deepgramTurns.shift();
//   }
//   deepgramTurns.push(text);
//
// The result is that the array always holds the _most recent_ turns
// rather than the first MAX_RETAINED_TURNS turns.
//
// The ws-handler module wires together many external dependencies
// (Twilio WS, OpenAI Realtime, Deepgram). We test:
//   1. Source-code structural checks that pin the ring-buffer pattern.
//   2. An inline re-implementation of the ring-buffer logic to verify
//      the algorithm independently of the WebSocket wiring.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "ws-handler.ts"), "utf8");

// ---------------------------------------------------------------------------
// Source structural checks — ring-buffer pattern
// ---------------------------------------------------------------------------
describe("ws-handler — ring-buffer pattern for turnHistory (PR change)", () => {
  it("uses turnHistory.shift() to drop the oldest entry when at capacity", () => {
    expect(SRC).toContain("turnHistory.shift()");
  });

  it("pushes to turnHistory unconditionally after the capacity check", () => {
    // The push must appear after the optional shift — not inside a
    // conditional branch that prevents it when at cap.
    const shiftIdx = SRC.indexOf("turnHistory.shift()");
    const pushIdx = SRC.indexOf("turnHistory.push(");
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(shiftIdx);
  });

  it("guards the shift with >= MAX_RETAINED_TURNS (not < )", () => {
    // The old pattern was `if (length < MAX_RETAINED_TURNS) push()`.
    // The new pattern is `if (length >= MAX_RETAINED_TURNS) shift(); push()`.
    const guardIdx = SRC.indexOf("turnHistory.length >= MAX_RETAINED_TURNS");
    expect(guardIdx).toBeGreaterThan(-1);
  });

  it("does NOT use the old pattern 'turnHistory.length < MAX_RETAINED_TURNS'", () => {
    // Guards against accidental revert to the capped-push approach.
    expect(SRC).not.toContain("turnHistory.length < MAX_RETAINED_TURNS");
  });
});

describe("ws-handler — ring-buffer pattern for deepgramTurns (PR change)", () => {
  it("uses deepgramTurns.shift() to drop the oldest Deepgram transcript when at capacity", () => {
    expect(SRC).toContain("deepgramTurns.shift()");
  });

  it("pushes to deepgramTurns unconditionally after the capacity check", () => {
    const shiftIdx = SRC.indexOf("deepgramTurns.shift()");
    const pushIdx = SRC.indexOf("deepgramTurns.push(");
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(shiftIdx);
  });

  it("guards the shift with >= MAX_RETAINED_TURNS (not < )", () => {
    const guardIdx = SRC.indexOf("deepgramTurns.length >= MAX_RETAINED_TURNS");
    expect(guardIdx).toBeGreaterThan(-1);
  });

  it("does NOT use the old pattern 'deepgramTurns.length < MAX_RETAINED_TURNS'", () => {
    expect(SRC).not.toContain("deepgramTurns.length < MAX_RETAINED_TURNS");
  });
});

describe("ws-handler — MAX_RETAINED_TURNS constant", () => {
  it("declares MAX_RETAINED_TURNS as a numeric constant", () => {
    expect(SRC).toMatch(/const MAX_RETAINED_TURNS\s*=\s*\d+/);
  });

  it("uses a value of 200 for MAX_RETAINED_TURNS", () => {
    expect(SRC).toContain("MAX_RETAINED_TURNS = 200");
  });
});

// ---------------------------------------------------------------------------
// Inline ring-buffer algorithm tests
// ---------------------------------------------------------------------------
// Re-implement the ring-buffer logic extracted from the PR change so we
// can verify the algorithm's behaviour directly without mocking the WS.

function makeRingBuffer<T>(maxSize: number) {
  const buf: T[] = [];
  function push(item: T): void {
    if (buf.length >= maxSize) {
      buf.shift();
    }
    buf.push(item);
  }
  function toArray(): T[] {
    return [...buf];
  }
  function size(): number {
    return buf.length;
  }
  return { push, toArray, size };
}

describe("ring-buffer algorithm (replicated from PR change)", () => {
  it("accumulates items up to the cap without dropping any", () => {
    const rb = makeRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.size()).toBe(3);
  });

  it("drops the oldest item once the cap is exceeded", () => {
    const rb = makeRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4); // should drop 1
    expect(rb.toArray()).toEqual([2, 3, 4]);
    expect(rb.size()).toBe(3);
  });

  it("always retains the most recent items after many pushes", () => {
    const rb = makeRingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) rb.push(i);
    // After 10 pushes into a cap-3 buffer, we should have [8, 9, 10].
    expect(rb.toArray()).toEqual([8, 9, 10]);
  });

  it("never exceeds the cap regardless of push count", () => {
    const rb = makeRingBuffer<string>(5);
    for (let i = 0; i < 1000; i++) rb.push(`turn-${i}`);
    expect(rb.size()).toBe(5);
  });

  it("returns an empty array before any pushes", () => {
    const rb = makeRingBuffer<string>(200);
    expect(rb.toArray()).toEqual([]);
  });

  it("with a cap of 1 only keeps the very latest item", () => {
    const rb = makeRingBuffer<string>(1);
    rb.push("a");
    rb.push("b");
    rb.push("c");
    expect(rb.toArray()).toEqual(["c"]);
  });

  it("old 'push-only-if-below-cap' behaviour would return different result (regression proof)", () => {
    // Under the OLD algorithm (push only when length < cap), after cap
    // is reached the latest items are SILENTLY DROPPED. This test
    // demonstrates the difference: the old algorithm would leave the
    // buffer at [1, 2, 3] even after 10 pushes.
    const cap = 3;
    const oldStyleBuf: number[] = [];
    for (let i = 1; i <= 10; i++) {
      // OLD: only push if below cap (items after cap are lost)
      if (oldStyleBuf.length < cap) {
        oldStyleBuf.push(i);
      }
    }
    expect(oldStyleBuf).toEqual([1, 2, 3]); // stale, not most-recent

    // NEW ring-buffer retains the most recent 3.
    const rb = makeRingBuffer<number>(cap);
    for (let i = 1; i <= 10; i++) rb.push(i);
    expect(rb.toArray()).toEqual([8, 9, 10]); // most recent
    expect(rb.toArray()).not.toEqual(oldStyleBuf);
  });
});

// ---------------------------------------------------------------------------
// Source structural checks — removed finalizeAndClose / resolveClosed (PR)
// ---------------------------------------------------------------------------
// The PR removed the shared `finalizeAndClose` helper and the `resolveClosed`
// resolver in favour of inline cleanup paths and `bridge.once("session.closed")`.
// These checks pin the absence of the removed patterns and presence of the
// replacement so a revert can be caught in review.
describe("ws-handler — removed finalizeAndClose / resolveClosed (PR change)", () => {
  it("does NOT define a finalizeAndClose helper", () => {
    // The idempotent finalizeAndClose abstraction was removed.
    expect(SRC).not.toContain("const finalizeAndClose = (");
  });

  it("does NOT use a resolveClosed resolver variable", () => {
    // The resolveClosed escape-hatch was removed; the returned promise
    // is now resolved directly from bridge.once("session.closed").
    expect(SRC).not.toContain("resolveClosed");
  });

  it("resolves the returned promise via bridge.once(\"session.closed\")", () => {
    // Replacement pattern: the promise returned by handleVoiceWsConnection
    // resolves when the bridge emits session.closed.
    expect(SRC).toContain('bridge.once("session.closed", () => resolve())');
  });

  it("uses force-cleanup-max-duration reason in the max-duration branch", () => {
    // The inline force-cleanup (replacing the old finalizeAndClose call)
    // closes the Twilio WS with this reason string.
    expect(SRC).toContain('"force-cleanup-max-duration"');
  });
});