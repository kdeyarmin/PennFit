import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  VoiceBridge,
  type MediaStreamSink,
  type ToolInvocation,
  type TranscriptTurn,
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
