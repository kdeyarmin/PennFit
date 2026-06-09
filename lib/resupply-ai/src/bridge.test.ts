import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  VoiceBridge,
  type MediaStreamSink,
  type SessionError,
  type ToolInvocation,
  type TranscriptTurn,
  type TtsStreamer,
  type TtsStreamHandlers,
  type TtsSynthesizer,
} from "./bridge";
import type { RealtimeClient } from "./realtime-client";
import type {
  DispatchToolCall,
  DispatchToolResult,
  ToolDispatcher,
} from "./tools";

// We don't want a real RealtimeClient (that owns a `ws`). Instead we
// stand up a TINY EventEmitter that quacks the same way and records
// outbound calls. The bridge reads .on(...), so an EventEmitter is
// straight-up sufficient.
class FakeRealtimeClient extends EventEmitter {
  appendAudio = vi.fn();
  commitInput = vi.fn();
  submitToolResult = vi.fn();
  requestResponse = vi.fn();
  close = vi.fn();
}

function buildSink(): MediaStreamSink & { written: string[]; cleared: number } {
  const written: string[] = [];
  let cleared = 0;
  return {
    written,
    get cleared() {
      return cleared;
    },
    set cleared(v: number) {
      cleared = v;
    },
    writeAudioBase64(b: string) {
      written.push(b);
    },
    clearQueuedAudio() {
      cleared += 1;
    },
  };
}

function buildBridge(dispatcher: ToolDispatcher): {
  bridge: VoiceBridge;
  fake: FakeRealtimeClient;
  sink: ReturnType<typeof buildSink>;
} {
  const fake = new FakeRealtimeClient();
  const sink = buildSink();
  const bridge = new VoiceBridge({
    client: fake as unknown as RealtimeClient,
    sink,
    dispatcher,
  });
  return { bridge, fake, sink };
}

describe("VoiceBridge", () => {
  it("emits session.opened on client open and forwards audio.delta to the sink", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake, sink } = buildBridge(dispatcher);
    const seen: string[] = [];
    bridge.on("session.opened", () => seen.push("opened"));
    fake.emit("open");
    fake.emit("audio.delta", { audioBase64: "AAAA", responseId: "r" });
    fake.emit("audio.delta", { audioBase64: "BBBB", responseId: "r" });
    expect(seen).toEqual(["opened"]);
    expect(sink.written).toEqual(["AAAA", "BBBB"]);
  });

  it("forwards caller audio into the realtime client's input buffer", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    bridge.forwardCallerAudio("XYZ123");
    expect(fake.appendAudio).toHaveBeenCalledWith("XYZ123");
  });

  it("coalesces output transcript deltas into ONE transcript.turn on done", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const turns: TranscriptTurn[] = [];
    bridge.on("transcript.turn", (t) => turns.push(t));
    fake.emit("transcript.delta", {
      source: "output",
      text: "Hello",
      done: false,
      itemId: "i1",
    });
    fake.emit("transcript.delta", {
      source: "output",
      text: " there",
      done: false,
      itemId: "i1",
    });
    fake.emit("transcript.delta", {
      source: "output",
      text: "Hello there",
      done: true,
      itemId: "i1",
    });
    expect(turns).toEqual([
      { source: "output", text: "Hello there", itemId: "i1" },
    ]);
  });

  it("does NOT emit a transcript.turn for a done with empty text and no buffered prior", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const turns: TranscriptTurn[] = [];
    bridge.on("transcript.turn", (t) => turns.push(t));
    fake.emit("transcript.delta", {
      source: "input",
      text: "",
      done: true,
      itemId: "i_x",
    });
    expect(turns).toEqual([]);
  });

  it("dispatches a known tool, audits success, AND submits the result back to the model", async () => {
    // Cast through `unknown` because the generic `dispatch<K>` signature
    // is awkward to satisfy with vi.fn — runtime contract is what
    // matters here, not the test fake's TS shape.
    const dispatch = vi.fn(
      async (call: DispatchToolCall) =>
        ({
          callId: call.callId,
          name: call.name,
          result: { matched: true, attempts_remaining: 2 },
        }) as DispatchToolResult,
    );
    const dispatcher = { dispatch } as unknown as ToolDispatcher;
    const { bridge, fake } = buildBridge(dispatcher);
    const invocations: ToolInvocation[] = [];
    bridge.on("tool.invoked", (i) => invocations.push(i));
    fake.emit("tool.call", {
      callId: "c1",
      name: "verify_patient_identity",
      argumentsJson: '{"date_of_birth":"1972-01-05"}',
    });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.status).toBe("ok");
    expect(invocations[0]!.name).toBe("verify_patient_identity");
    // The summary MUST NOT carry the raw DOB
    expect(JSON.stringify(invocations[0]!.auditArgs)).not.toContain("1972");
    expect(fake.submitToolResult).toHaveBeenCalledWith("c1", {
      matched: true,
      attempts_remaining: 2,
    });
  });

  it("rejects an unknown tool name with status='unknown_tool' and surfaces a model-readable error", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const invocations: ToolInvocation[] = [];
    bridge.on("tool.invoked", (i) => invocations.push(i));
    fake.emit("tool.call", {
      callId: "c1",
      name: "shutdown_system",
      argumentsJson: "{}",
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.status).toBe("unknown_tool");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(fake.submitToolResult).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ ok: false, error: "unknown_tool" }),
    );
  });

  it("validates args against zod and reports a validation_error WITHOUT dispatching", async () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const invocations: ToolInvocation[] = [];
    bridge.on("tool.invoked", (i) => invocations.push(i));
    fake.emit("tool.call", {
      callId: "c2",
      name: "verify_patient_identity",
      argumentsJson: '{"date_of_birth":"Jan 5 1972"}',
    });
    await new Promise((r) => setImmediate(r));
    expect(invocations[0]!.status).toBe("validation_error");
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(fake.submitToolResult).toHaveBeenCalledWith(
      "c2",
      expect.objectContaining({ ok: false, error: "invalid_arguments" }),
    );
  });

  it("invalid JSON arguments surface as a validation_error, not a crash", async () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const invocations: ToolInvocation[] = [];
    bridge.on("tool.invoked", (i) => invocations.push(i));
    fake.emit("tool.call", {
      callId: "c3",
      name: "verify_patient_identity",
      argumentsJson: "not-json",
    });
    await new Promise((r) => setImmediate(r));
    expect(invocations[0]!.status).toBe("validation_error");
    expect(invocations[0]!.errorMessage).toMatch(/arguments_not_json/);
  });

  it("dispatch errors are caught, audited as dispatch_error, and a recovery message is sent to the model", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("db unreachable");
    });
    const dispatcher = { dispatch } as unknown as ToolDispatcher;
    const { bridge, fake } = buildBridge(dispatcher);
    const invocations: ToolInvocation[] = [];
    const errors: { source: string; message: string }[] = [];
    bridge.on("tool.invoked", (i) => invocations.push(i));
    bridge.on("session.error", (e) =>
      errors.push({ source: e.source, message: e.message }),
    );
    fake.emit("tool.call", {
      callId: "c4",
      name: "lookup_resupply_inventory",
      argumentsJson: "{}",
    });
    await new Promise((r) => setImmediate(r));
    expect(invocations[0]!.status).toBe("dispatch_error");
    expect(errors[0]?.source).toBe("tool");
    expect(fake.submitToolResult).toHaveBeenCalledWith(
      "c4",
      expect.objectContaining({ ok: false, error: "dispatch_failed" }),
    );
  });

  it("end_call tool result also closes the realtime client (clean hangup signal)", async () => {
    const dispatch = vi.fn(
      async (call: DispatchToolCall) =>
        ({
          callId: call.callId,
          name: call.name,
          result: { ok: true },
        }) as DispatchToolResult,
    );
    const dispatcher = { dispatch } as unknown as ToolDispatcher;
    const { bridge: _bridge, fake } = buildBridge(dispatcher);
    fake.emit("tool.call", {
      callId: "c5",
      name: "end_call",
      argumentsJson: '{"outcome":"completed"}',
    });
    await new Promise((r) => setImmediate(r));
    expect(fake.close).toHaveBeenCalledWith(1000, "end_call_tool_invoked");
  });

  it("propagates client-level errors as session.error with source='openai'", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const errors: { source: string; code: string }[] = [];
    bridge.on("session.error", (e) =>
      errors.push({ source: e.source, code: e.code }),
    );
    fake.emit("error", { code: "rate_limited", message: "x" });
    expect(errors).toEqual([{ source: "openai", code: "rate_limited" }]);
  });

  it("propagates closure as session.closed", () => {
    const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
    const { bridge, fake } = buildBridge(dispatcher);
    const closes: { code: number; reason: string }[] = [];
    bridge.on("session.closed", (i) => closes.push(i));
    fake.emit("closed", { code: 1011, reason: "x" });
    expect(closes).toEqual([{ code: 1011, reason: "x" }]);
  });
});

// ---------------------------------------------------------------------------
// External-TTS path (ElevenLabs). When a `tts` synthesizer is supplied,
// the bridge produces the agent's voice itself: it ignores the model's
// built-in audio.delta and synthesises each finalised OUTPUT transcript
// turn, with caller barge-in aborting the in-flight synthesis.
// ---------------------------------------------------------------------------

function buildBridgeWithTts(tts: TtsSynthesizer): {
  bridge: VoiceBridge;
  fake: FakeRealtimeClient;
  sink: ReturnType<typeof buildSink>;
} {
  const fake = new FakeRealtimeClient();
  const sink = buildSink();
  const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
  const bridge = new VoiceBridge({
    client: fake as unknown as RealtimeClient,
    sink,
    dispatcher,
    tts,
  });
  return { bridge, fake, sink };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("VoiceBridge — external TTS path", () => {
  it("ignores model audio.delta and synthesises finalised OUTPUT turns instead", async () => {
    const tts: TtsSynthesizer = {
      async synthesize(text, onFrame) {
        onFrame(`a:${text}`);
        onFrame(`b:${text}`);
      },
    };
    const { fake, sink } = buildBridgeWithTts(tts);

    // Built-in audio is suppressed — we own the voice now.
    fake.emit("audio.delta", { audioBase64: "CEDAR", responseId: "r" });
    expect(sink.written).toEqual([]);

    // A finalised agent turn is synthesised to the sink.
    fake.emit("transcript.delta", {
      source: "output",
      text: "Hi there",
      done: true,
      itemId: "o1",
    });
    await flush();
    expect(sink.written).toEqual(["a:Hi there", "b:Hi there"]);
  });

  it("streams the agent's voice sentence-by-sentence: a finished sentence is synthesised before the turn finalises, and is not re-spoken on done", async () => {
    const synthesized: string[] = [];
    const tts: TtsSynthesizer = {
      async synthesize(text, onFrame) {
        synthesized.push(text);
        onFrame(`f:${text}`);
      },
    };
    const { fake } = buildBridgeWithTts(tts);

    // First sentence completes mid-stream (terminal punctuation + space).
    fake.emit("transcript.delta", {
      source: "output",
      text: "Sure, let me pull that up. ",
      done: false,
      itemId: "o1",
    });
    await flush();
    // The completed first sentence is synthesised immediately — we did NOT
    // wait for the whole turn to finalise.
    expect(synthesized).toEqual(["Sure, let me pull that up."]);

    // The rest of the turn streams in (no terminator yet → not flushed),
    // then the turn finalises with the full text.
    fake.emit("transcript.delta", {
      source: "output",
      text: "You've got a mask and tubing due",
      done: false,
      itemId: "o1",
    });
    fake.emit("transcript.delta", {
      source: "output",
      text: "Sure, let me pull that up. You've got a mask and tubing due.",
      done: true,
      itemId: "o1",
    });
    await flush();
    // Only the un-spoken tail is synthesised on done — the first sentence
    // is NOT re-spoken.
    expect(synthesized).toEqual([
      "Sure, let me pull that up.",
      "You've got a mask and tubing due.",
    ]);
  });

  it("does NOT synthesise the caller's (input) turns", async () => {
    const calls: string[] = [];
    const tts: TtsSynthesizer = {
      async synthesize(text, onFrame) {
        calls.push(text);
        onFrame(text);
      },
    };
    const { fake, sink } = buildBridgeWithTts(tts);
    fake.emit("transcript.delta", {
      source: "input",
      text: "my date of birth is...",
      done: true,
      itemId: "i1",
    });
    await flush();
    expect(calls).toEqual([]);
    expect(sink.written).toEqual([]);
  });

  it("synthesises queued utterances in order (one at a time)", async () => {
    const tts: TtsSynthesizer = {
      async synthesize(text, onFrame) {
        // Yield once so a second enqueue lands while the first is mid-flight.
        await Promise.resolve();
        onFrame(`f:${text}`);
      },
    };
    const { fake, sink } = buildBridgeWithTts(tts);
    fake.emit("transcript.delta", {
      source: "output",
      text: "one",
      done: true,
      itemId: "o1",
    });
    fake.emit("transcript.delta", {
      source: "output",
      text: "two",
      done: true,
      itemId: "o2",
    });
    await flush();
    expect(sink.written).toEqual(["f:one", "f:two"]);
  });

  it("barge-in aborts in-flight synthesis, drops late frames, and flushes the sink", async () => {
    let release: (() => void) | null = null;
    let abortedDuringSynthesis = false;
    const tts: TtsSynthesizer = {
      async synthesize(text, onFrame, signal) {
        onFrame(`early:${text}`);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        abortedDuringSynthesis = signal.aborted;
        // Adversarial: emit a late frame unconditionally — the bridge's
        // own guard must drop it because the signal is aborted.
        onFrame(`late:${text}`);
      },
    };
    const { fake, sink } = buildBridgeWithTts(tts);

    fake.emit("transcript.delta", {
      source: "output",
      text: "hello",
      done: true,
      itemId: "o1",
    });
    await flush();
    expect(sink.written).toEqual(["early:hello"]);

    // Caller interrupts.
    fake.emit("input.speech_started");
    expect(sink.cleared).toBe(1);

    // Let the synthesis finish; the late frame must be suppressed.
    release!();
    await flush();
    expect(abortedDuringSynthesis).toBe(true);
    expect(sink.written).toEqual(["early:hello"]);
  });

  it("a synthesis failure surfaces session.error(source='tts') without ending the call", async () => {
    const tts: TtsSynthesizer = {
      async synthesize() {
        throw new Error("elevenlabs http 500");
      },
    };
    const { bridge, fake } = buildBridgeWithTts(tts);
    const errors: SessionError[] = [];
    bridge.on("session.error", (e) => errors.push(e));
    fake.emit("transcript.delta", {
      source: "output",
      text: "boom",
      done: true,
      itemId: "o1",
    });
    await flush();
    expect(errors.some((e) => e.source === "tts")).toBe(true);
    // A TTS failure drops that utterance's audio but does NOT close the call.
    expect(fake.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Streaming-TTS path (ElevenLabs stream-input WS). When a `ttsStreamer` is
// supplied, the bridge opens ONE session per agent turn and feeds the
// model's output text into it as it streams, ending the session when the
// turn finalises. Caller barge-in aborts the open session.
// ---------------------------------------------------------------------------

interface FakeStreamRecord {
  pushed: string[];
  flushes: number;
  ended: boolean;
  aborted: boolean;
  handlers: TtsStreamHandlers;
}

function buildBridgeWithStreamer(): {
  bridge: VoiceBridge;
  fake: FakeRealtimeClient;
  sink: ReturnType<typeof buildSink>;
  sessions: FakeStreamRecord[];
} {
  const fake = new FakeRealtimeClient();
  const sink = buildSink();
  const dispatcher: ToolDispatcher = { dispatch: vi.fn() };
  const sessions: FakeStreamRecord[] = [];
  const streamer: TtsStreamer = {
    openSession(handlers) {
      const rec: FakeStreamRecord = {
        pushed: [],
        flushes: 0,
        ended: false,
        aborted: false,
        handlers,
      };
      sessions.push(rec);
      return {
        pushText: (t) => rec.pushed.push(t),
        flush: () => {
          rec.flushes += 1;
        },
        end: () => {
          rec.ended = true;
        },
        abort: () => {
          rec.aborted = true;
        },
      };
    },
  };
  const bridge = new VoiceBridge({
    client: fake as unknown as RealtimeClient,
    sink,
    dispatcher,
    ttsStreamer: streamer,
  });
  return { bridge, fake, sink, sessions };
}

describe("VoiceBridge — streaming TTS path", () => {
  it("ignores built-in audio.delta when a streamer owns the voice", () => {
    const { fake, sink } = buildBridgeWithStreamer();
    fake.emit("audio.delta", { audioBase64: "CEDAR", responseId: "r" });
    expect(sink.written).toEqual([]);
  });

  it("opens one session per turn, pushes only newly-streamed text, flushes at sentence ends, and ends on done", () => {
    const { fake, sink, sessions } = buildBridgeWithStreamer();

    fake.emit("transcript.delta", {
      source: "output",
      text: "Hello there. ",
      done: false,
      itemId: "o1",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pushed).toEqual(["Hello there. "]);
    // Sentence terminator present → a flush was requested.
    expect(sessions[0]!.flushes).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.ended).toBe(false);

    fake.emit("transcript.delta", {
      source: "output",
      text: "Hello there. You're all set.",
      done: true,
      itemId: "o1",
    });
    // Only the NEW tail is pushed — never re-pushing "Hello there. ".
    expect(sessions[0]!.pushed).toEqual(["Hello there. ", "You're all set."]);
    expect(sessions[0]!.ended).toBe(true);
    // Still exactly one session for the whole turn.
    expect(sessions).toHaveLength(1);

    // Audio frames the engine streams back reach the sink.
    sessions[0]!.handlers.onFrame("AAAA");
    expect(sink.written).toEqual(["AAAA"]);
  });

  it("still emits transcript.turn on done (so the transcript is persisted)", () => {
    const { bridge, fake } = buildBridgeWithStreamer();
    const turns: TranscriptTurn[] = [];
    bridge.on("transcript.turn", (t) => turns.push(t));
    fake.emit("transcript.delta", {
      source: "output",
      text: "All set.",
      done: true,
      itemId: "o1",
    });
    expect(turns).toEqual([
      { source: "output", text: "All set.", itemId: "o1" },
    ]);
  });

  it("drops late frames from a session that has been replaced by the next turn", () => {
    const { fake, sink, sessions } = buildBridgeWithStreamer();

    fake.emit("transcript.delta", {
      source: "output",
      text: "One.",
      done: true,
      itemId: "o1",
    });
    // New turn → a second session opens and becomes current.
    fake.emit("transcript.delta", {
      source: "output",
      text: "Two ",
      done: false,
      itemId: "o2",
    });
    expect(sessions).toHaveLength(2);

    // A late frame from the FIRST (replaced) session must be dropped.
    sessions[0]!.handlers.onFrame("LATE");
    // A frame from the current session is forwarded.
    sessions[1]!.handlers.onFrame("OK");
    expect(sink.written).toEqual(["OK"]);
  });

  it("barge-in aborts the open session and clears the sink; later frames are dropped", () => {
    const { fake, sink, sessions } = buildBridgeWithStreamer();
    fake.emit("transcript.delta", {
      source: "output",
      text: "Let me check ",
      done: false,
      itemId: "o1",
    });
    expect(sessions).toHaveLength(1);

    fake.emit("input.speech_started");
    expect(sessions[0]!.aborted).toBe(true);
    expect(sink.cleared).toBe(1);

    // Frames arriving after the abort are dropped (session no longer current).
    sessions[0]!.handlers.onFrame("LATE");
    expect(sink.written).toEqual([]);
  });

  it("after barge-in, a stray delta for the SAME turn does not reopen a session (no re-speak)", () => {
    const { fake, sessions } = buildBridgeWithStreamer();
    fake.emit("transcript.delta", {
      source: "output",
      text: "Your order is ",
      done: false,
      itemId: "o1",
    });
    expect(sessions).toHaveLength(1);

    fake.emit("input.speech_started"); // caller interrupts
    expect(sessions[0]!.aborted).toBe(true);

    // A late delta for the SAME interrupted item arrives after the cancel.
    fake.emit("transcript.delta", {
      source: "output",
      text: "Your order is on the way.",
      done: true,
      itemId: "o1",
    });
    // No second session opened — the interrupted turn is not re-spoken.
    expect(sessions).toHaveLength(1);
  });

  it("does NOT open a session for the caller's (input) turns", () => {
    const { fake, sessions } = buildBridgeWithStreamer();
    fake.emit("transcript.delta", {
      source: "input",
      text: "my date of birth is...",
      done: true,
      itemId: "i1",
    });
    expect(sessions).toEqual([]);
  });

  it("a streaming session error surfaces session.error(source='tts') without ending the call", () => {
    const { bridge, fake, sessions } = buildBridgeWithStreamer();
    const errors: SessionError[] = [];
    bridge.on("session.error", (e) => errors.push(e));
    fake.emit("transcript.delta", {
      source: "output",
      text: "boom.",
      done: true,
      itemId: "o1",
    });
    sessions[0]!.handlers.onError(new Error("elevenlabs ws hang up"));
    expect(errors.some((e) => e.source === "tts")).toBe(true);
    // The errored vendor session is torn down (not left open streaming
    // audio we'd discard) — but the CALL itself continues.
    expect(sessions[0]!.aborted).toBe(true);
    expect(fake.close).not.toHaveBeenCalled();
  });
});
