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
// PR change: Deepgram error de-spam — source structural checks
//
// The PR introduces two new variables around the Deepgram error handler:
//   - deepgramErrorCount: incremented on every Deepgram error.
//   - deepgramWarnEmitted: flipped to true after the first WARN so
//     subsequent errors during the same call drop to DEBUG instead of
//     re-firing the WARN (de-spamming a sustained outage).
// A single end-of-call WARN emits the total count so dashboards can rank
// calls by Deepgram error severity without drowning in per-error noise.
// ---------------------------------------------------------------------------

describe("ws-handler — Deepgram error de-spam (PR change)", () => {
  it("declares deepgramErrorCount as a let variable initialised to 0", () => {
    expect(SRC).toMatch(/let deepgramErrorCount\s*=\s*0/);
  });

  it("declares deepgramWarnEmitted as a let variable initialised to false", () => {
    expect(SRC).toMatch(/let deepgramWarnEmitted\s*=\s*false/);
  });

  it("increments deepgramErrorCount on every error", () => {
    expect(SRC).toContain("deepgramErrorCount += 1");
  });

  it("emits subsequent errors at DEBUG level (not WARN) when deepgramWarnEmitted is true", () => {
    // The de-spam guard must check deepgramWarnEmitted before deciding
    // whether to call logger.warn or logger.debug.
    expect(SRC).toContain("if (deepgramWarnEmitted)");
    expect(SRC).toContain('"voice_deepgram_error_subsequent"');
  });

  it("sets deepgramWarnEmitted = true before the first WARN fires", () => {
    // The flag must be set before the WARN so a crash-on-log doesn't
    // leave the flag false (which would re-fire the WARN on the next
    // error in the same call).
    const warnEmittedSetIdx = SRC.indexOf("deepgramWarnEmitted = true");
    const firstWarnIdx = SRC.indexOf('"voice_deepgram_error"');
    expect(warnEmittedSetIdx).toBeGreaterThan(-1);
    expect(firstWarnIdx).toBeGreaterThan(-1);
    // The assignment must come before the event string in the source.
    expect(warnEmittedSetIdx).toBeLessThan(firstWarnIdx);
  });

  it("emits a single end-of-call summary WARN with the error count", () => {
    expect(SRC).toContain('"voice_deepgram_errors_summary"');
    expect(SRC).toContain("count: deepgramErrorCount");
  });

  it("guards the end-of-call summary log with deepgramErrorCount > 0", () => {
    // The summary should only fire when there was at least one error —
    // a zero-error call must not emit the WARN at all.
    expect(SRC).toContain("if (deepgramErrorCount > 0)");
  });

  it("includes the conversationId in both the per-error debug log and the summary", () => {
    expect(SRC).toContain('"voice_deepgram_error_subsequent"');
    expect(SRC).toContain('"voice_deepgram_errors_summary"');
    // Both events include conversationId for log correlation.
    const subsequentIdx = SRC.indexOf('"voice_deepgram_error_subsequent"');
    const summaryIdx = SRC.indexOf('"voice_deepgram_errors_summary"');
    // Each block around the event contains conversationId.
    expect(SRC.slice(subsequentIdx, subsequentIdx + 300)).toContain("conversationId");
    expect(SRC.slice(summaryIdx, summaryIdx + 300)).toContain("conversationId");
  });
});

// ---------------------------------------------------------------------------
// De-spam algorithm — pure logic tests
//
// Re-implement the de-spam state machine so we can test the branching
// logic without needing the full WebSocket wiring.
// ---------------------------------------------------------------------------

function makeDeepgramErrorTracker() {
  let errorCount = 0;
  let warnEmitted = false;
  const warnLog: unknown[] = [];
  const debugLog: unknown[] = [];

  function onError(code: string) {
    errorCount += 1;
    if (warnEmitted) {
      debugLog.push({ event: "voice_deepgram_error_subsequent", code, count: errorCount });
      return;
    }
    warnEmitted = true;
    warnLog.push({ event: "voice_deepgram_error", code });
  }

  function onClose() {
    if (errorCount > 0) {
      warnLog.push({ event: "voice_deepgram_errors_summary", count: errorCount });
    }
  }

  return { onError, onClose, getWarnLog: () => warnLog, getDebugLog: () => debugLog, getErrorCount: () => errorCount };
}

describe("Deepgram error de-spam algorithm (replicated from PR change)", () => {
  it("emits exactly one WARN for the first error", () => {
    const tracker = makeDeepgramErrorTracker();
    tracker.onError("1011");
    expect(tracker.getWarnLog()).toHaveLength(1);
    expect(tracker.getWarnLog()[0]).toMatchObject({ event: "voice_deepgram_error" });
    expect(tracker.getDebugLog()).toHaveLength(0);
  });

  it("emits DEBUG (not WARN) for subsequent errors in the same call", () => {
    const tracker = makeDeepgramErrorTracker();
    tracker.onError("1011"); // first — WARN
    tracker.onError("1011"); // second — DEBUG
    tracker.onError("1011"); // third — DEBUG
    expect(tracker.getWarnLog()).toHaveLength(1); // still just 1 WARN
    expect(tracker.getDebugLog()).toHaveLength(2);
  });

  it("increments the error count for every error regardless of de-spam", () => {
    const tracker = makeDeepgramErrorTracker();
    tracker.onError("1011");
    tracker.onError("1011");
    tracker.onError("1011");
    expect(tracker.getErrorCount()).toBe(3);
  });

  it("emits the summary WARN on close when there were errors", () => {
    const tracker = makeDeepgramErrorTracker();
    tracker.onError("1011");
    tracker.onError("1011");
    tracker.onClose();
    const summaryLog = tracker.getWarnLog().find(
      (l) => (l as { event: string }).event === "voice_deepgram_errors_summary",
    );
    expect(summaryLog).toBeDefined();
    expect((summaryLog as { count: number }).count).toBe(2);
  });

  it("does NOT emit the summary WARN on clean close (zero errors)", () => {
    const tracker = makeDeepgramErrorTracker();
    tracker.onClose(); // no errors before this
    const summaryLog = tracker.getWarnLog().find(
      (l) => (l as { event: string }).event === "voice_deepgram_errors_summary",
    );
    expect(summaryLog).toBeUndefined();
  });

  it("summary count matches the total number of errors (including de-spammed ones)", () => {
    const tracker = makeDeepgramErrorTracker();
    for (let i = 0; i < 10; i++) tracker.onError("1011");
    tracker.onClose();
    const summary = tracker.getWarnLog().find(
      (l) => (l as { event: string }).event === "voice_deepgram_errors_summary",
    ) as { count: number } | undefined;
    expect(summary?.count).toBe(10);
  });
});