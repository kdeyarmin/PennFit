import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeClient, type WebSocketLike } from "./realtime-client";
import { OPENAI_TOOL_DESCRIPTORS, TOOL_NAMES } from "./tools";

// A minimal WebSocket fake. Tests reach into `.received` to assert the
// outbound JSON traffic and call `.fakeMessage()` / `.fakeOpen()` to
// drive the inbound demux. This keeps the tests fully synchronous
// (no real WS, no timers) and makes failures readable.
class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  received: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  send(data: string | Buffer): void {
    this.received.push(typeof data === "string" ? data : data.toString("utf8"));
  }
  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
  fakeOpen(): void {
    this.emit("open");
  }
  fakeMessage(payload: unknown): void {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", Buffer.from(text, "utf8"));
  }
  fakeError(err: Error): void {
    this.emit("error", err);
  }
}

const allowedToolNames = new Set(TOOL_NAMES);

function build(opts: { instructions?: string } = {}): {
  client: RealtimeClient;
  fake: FakeWebSocket;
  capturedHeaders: Record<string, string>;
  capturedUrl: string;
} {
  const fake = new FakeWebSocket();
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const client = new RealtimeClient({
    apiKey: "sk-test-1234",
    instructions: opts.instructions ?? "system prompt",
    tools: OPENAI_TOOL_DESCRIPTORS,
    allowedToolNames,
    webSocketFactory: (url, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return fake;
    },
  });
  return {
    client,
    fake,
    capturedHeaders,
    get capturedUrl() {
      return capturedUrl;
    },
  } as unknown as {
    client: RealtimeClient;
    fake: FakeWebSocket;
    capturedHeaders: Record<string, string>;
    capturedUrl: string;
  };
}

describe("RealtimeClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an API key — refuses to construct without one", () => {
    expect(
      () =>
        new RealtimeClient({
          apiKey: "",
          instructions: "x",
          tools: OPENAI_TOOL_DESCRIPTORS,
          allowedToolNames,
          webSocketFactory: () => new FakeWebSocket(),
        }),
    ).toThrow(/apiKey/);
  });

  it("connects to the realtime URL with the model query param and the auth headers", () => {
    const { capturedUrl, capturedHeaders } = build();
    expect(capturedUrl).toBe(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    );
    expect(capturedHeaders.Authorization).toBe("Bearer sk-test-1234");
    expect(capturedHeaders["OpenAI-Beta"]).toBe("realtime=v1");
  });

  it("sends a session.update on open with µ-law I/O, semantic-VAD, temperature, and the tool list", () => {
    const { fake } = build({ instructions: "do the thing" });
    fake.fakeOpen();
    expect(fake.received.length).toBe(1);
    const sent = JSON.parse(fake.received[0]!);
    expect(sent.type).toBe("session.update");
    expect(sent.session.input_audio_format).toBe("g711_ulaw");
    expect(sent.session.output_audio_format).toBe("g711_ulaw");
    // semantic_vad waits for end-of-thought rather than fixed silence —
    // the single biggest "feels human" tuning lever on Realtime API.
    expect(sent.session.turn_detection.type).toBe("semantic_vad");
    expect(sent.session.turn_detection.eagerness).toBe("low");
    expect(sent.session.turn_detection.interrupt_response).toBe(true);
    // Small temperature bump for natural phrasing variation across turns.
    expect(sent.session.temperature).toBeGreaterThan(0);
    expect(sent.session.max_response_output_tokens).toBeGreaterThan(0);
    // cedar is the warmest of the current Realtime voices.
    expect(sent.session.voice).toBe("cedar");
    expect(sent.session.instructions).toBe("do the thing");
    expect(Array.isArray(sent.session.tools)).toBe(true);
    expect(sent.session.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("runs in text-output mode when generateAudio:false (external TTS owns the voice)", () => {
    const fake = new FakeWebSocket();
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      generateAudio: false,
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: () => fake,
    });
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    // Output is text-only; the model must NOT generate its own audio.
    expect(sent.session.modalities).toEqual(["text"]);
    expect(sent.session.voice).toBeUndefined();
    expect(sent.session.output_audio_format).toBeUndefined();
    // Input STT + VAD are unchanged so the model still hears the caller.
    expect(sent.session.input_audio_format).toBe("g711_ulaw");
    expect(sent.session.input_audio_transcription.model).toBe(
      "gpt-4o-mini-transcribe",
    );
    expect(sent.session.turn_detection.type).toBe("semantic_vad");
  });

  // --- GA session schema (gpt-realtime-2 spike, feature-flagged) ----------

  it("GA schema: omits the realtime=v1 beta header and emits the nested audio.input/output session", () => {
    const fake = new FakeWebSocket();
    let capturedHeaders: Record<string, string> = {};
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "do the thing",
      sessionSchema: "ga",
      model: "gpt-realtime-2",
      transcriptionModel: "gpt-realtime-whisper",
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: (_url, headers) => {
        capturedHeaders = headers;
        return fake;
      },
    });
    // GA reaches the GA schema WITHOUT the beta marker.
    expect(capturedHeaders["OpenAI-Beta"]).toBeUndefined();
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    expect(sent.session.type).toBe("realtime");
    expect(sent.session.model).toBe("gpt-realtime-2");
    expect(sent.session.output_modalities).toEqual(["audio"]);
    // µ-law nested under audio.input/output (default token: audio/pcmu).
    expect(sent.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(sent.session.audio.output.format).toEqual({ type: "audio/pcmu" });
    expect(sent.session.audio.output.voice).toBe("cedar");
    expect(sent.session.audio.input.transcription.model).toBe(
      "gpt-realtime-whisper",
    );
    expect(sent.session.audio.input.turn_detection.type).toBe("semantic_vad");
    // Reasoning model: depth via effort, not temperature.
    expect(sent.session.reasoning.effort).toBe("low");
    expect(sent.session.temperature).toBeUndefined();
    expect(sent.session.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("GA schema with external TTS (generateAudio:false): text-only output, no audio.output, input STT intact", () => {
    const fake = new FakeWebSocket();
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      sessionSchema: "ga",
      generateAudio: false,
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: () => fake,
    });
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    expect(sent.session.output_modalities).toEqual(["text"]);
    expect(sent.session.audio.output).toBeUndefined();
    // The model still hears the caller (input audio + STT unchanged).
    expect(sent.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(sent.session.audio.input.turn_detection.type).toBe("semantic_vad");
  });

  it("GA schema: audioFormat override corrects the µ-law token (preview-validation hook)", () => {
    const fake = new FakeWebSocket();
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      sessionSchema: "ga",
      audioFormat: "g711_ulaw",
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: () => fake,
    });
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    expect(sent.session.audio.input.format).toEqual({ type: "g711_ulaw" });
  });

  it("GA schema with no overrides defaults to the COHERENT GA pair (gpt-realtime-2 + gpt-realtime-whisper)", () => {
    const fake = new FakeWebSocket();
    let capturedUrl = "";
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      sessionSchema: "ga",
      // No model / transcriptionModel override.
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: (url) => {
        capturedUrl = url;
        return fake;
      },
    });
    // GA mode alone never pairs the GA wire shape with the beta model/STT.
    expect(capturedUrl).toBe(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
    );
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    expect(sent.session.model).toBe("gpt-realtime-2");
    expect(sent.session.audio.input.transcription.model).toBe(
      "gpt-realtime-whisper",
    );
  });

  it("maps text-output events onto output transcript turns (text-mode)", () => {
    const fake = new FakeWebSocket();
    const client = new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      generateAudio: false,
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames,
      webSocketFactory: () => fake,
    });
    const deltas: { source: string; text: string; done: boolean }[] = [];
    client.on("transcript.delta", (d) =>
      deltas.push({ source: d.source, text: d.text, done: d.done }),
    );
    fake.fakeOpen();
    fake.fakeMessage({ type: "response.output_text.delta", delta: "Hel" });
    fake.fakeMessage({ type: "response.output_text.done", text: "Hello" });
    expect(deltas).toEqual([
      { source: "output", text: "Hel", done: false },
      { source: "output", text: "Hello", done: true },
    ]);
  });

  it("emits input.speech_started for barge-in", () => {
    const { client, fake } = build();
    let started = 0;
    client.on("input.speech_started", () => {
      started += 1;
    });
    fake.fakeOpen();
    fake.fakeMessage({ type: "input_audio_buffer.speech_started" });
    expect(started).toBe(1);
  });

  it("filters tools against allowedToolNames so an over-broad descriptor list cannot smuggle a tool through", () => {
    const fake = new FakeWebSocket();
    new RealtimeClient({
      apiKey: "sk-test",
      instructions: "x",
      tools: OPENAI_TOOL_DESCRIPTORS,
      allowedToolNames: new Set([
        "end_call",
        "verify_patient_identity",
      ] as const),
      webSocketFactory: () => fake,
    });
    fake.fakeOpen();
    const sent = JSON.parse(fake.received[0]!);
    const names = sent.session.tools
      .map((t: { name: string }) => t.name)
      .sort();
    expect(names).toEqual(["end_call", "verify_patient_identity"]);
  });

  it("emits 'open' after sending session.update so listeners always see a configured session", () => {
    const { client, fake } = build();
    const seen: string[] = [];
    client.on("open", () => seen.push("open"));
    fake.fakeOpen();
    expect(seen).toEqual(["open"]);
    expect(fake.received.length).toBe(1);
  });

  it("translates response.audio.delta into 'audio.delta' carrying the raw base64 payload", () => {
    const { client, fake } = build();
    const seen: { audioBase64: string; responseId: string }[] = [];
    client.on("audio.delta", (d) => seen.push(d));
    fake.fakeOpen();
    fake.fakeMessage({
      type: "response.audio.delta",
      delta: "AAAA",
      response_id: "resp_1",
    });
    expect(seen).toEqual([{ audioBase64: "AAAA", responseId: "resp_1" }]);
  });

  it("treats response.output_audio.delta as a synonym for response.audio.delta", () => {
    const { client, fake } = build();
    const seen: string[] = [];
    client.on("audio.delta", (d) => seen.push(d.audioBase64));
    fake.fakeOpen();
    fake.fakeMessage({
      type: "response.output_audio.delta",
      delta: "BBBB",
      response_id: "r2",
    });
    expect(seen).toEqual(["BBBB"]);
  });

  it("emits a streaming OUTPUT transcript delta then a final done, both via 'transcript.delta'", () => {
    const { client, fake } = build();
    const seen: { source: string; text: string; done: boolean }[] = [];
    client.on("transcript.delta", (d) =>
      seen.push({ source: d.source, text: d.text, done: d.done }),
    );
    fake.fakeOpen();
    fake.fakeMessage({
      type: "response.audio_transcript.delta",
      delta: "Hello",
      response_id: "r1",
      item_id: "i1",
    });
    fake.fakeMessage({
      type: "response.audio_transcript.done",
      transcript: "Hello there",
      response_id: "r1",
      item_id: "i1",
    });
    expect(seen).toEqual([
      { source: "output", text: "Hello", done: false },
      { source: "output", text: "Hello there", done: true },
    ]);
  });

  it("emits an INPUT transcript completion when STT finalises", () => {
    const { client, fake } = build();
    const seen: { source: string; text: string; done: boolean }[] = [];
    client.on("transcript.delta", (d) =>
      seen.push({ source: d.source, text: d.text, done: d.done }),
    );
    fake.fakeOpen();
    fake.fakeMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "my date of birth is January fifth nineteen seventy two",
      item_id: "item_in_1",
    });
    expect(seen).toEqual([
      {
        source: "input",
        text: "my date of birth is January fifth nineteen seventy two",
        done: true,
      },
    ]);
  });

  it("dispatches tool.call on response.function_call_arguments.done with the call_id and raw JSON args", () => {
    const { client, fake } = build();
    const seen: { callId: string; name: string; argumentsJson: string }[] = [];
    client.on("tool.call", (c) =>
      seen.push({
        callId: c.callId,
        name: c.name,
        argumentsJson: c.argumentsJson,
      }),
    );
    fake.fakeOpen();
    fake.fakeMessage({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "verify_patient_identity",
      arguments: '{"date_of_birth":"1972-01-05"}',
    });
    expect(seen).toEqual([
      {
        callId: "call_1",
        name: "verify_patient_identity",
        argumentsJson: '{"date_of_birth":"1972-01-05"}',
      },
    ]);
  });

  it("converts an OpenAI-side error event into an 'error' emission with code+message", () => {
    const { client, fake } = build();
    const seen: { code: string; message: string }[] = [];
    client.on("error", (e) => seen.push(e));
    fake.fakeOpen();
    fake.fakeMessage({
      type: "error",
      error: { code: "rate_limited", message: "slow down" },
    });
    expect(seen).toEqual([{ code: "rate_limited", message: "slow down" }]);
  });

  it("emits 'error' with code=invalid_json when the upstream sends garbage", () => {
    const { client, fake } = build();
    const seen: { code: string }[] = [];
    client.on("error", (e) => seen.push({ code: e.code }));
    fake.fakeOpen();
    fake.fakeMessage("not-json{{{");
    expect(seen[0]?.code).toBe("invalid_json");
  });

  it("appendAudio sends an input_audio_buffer.append frame", () => {
    const { client, fake } = build();
    fake.fakeOpen();
    fake.received.length = 0; // discard the session.update
    client.appendAudio("AAAA");
    expect(fake.received).toHaveLength(1);
    expect(JSON.parse(fake.received[0]!)).toEqual({
      type: "input_audio_buffer.append",
      audio: "AAAA",
    });
  });

  it("buffers caller audio sent BEFORE the WS opens and flushes it after session.update", () => {
    // Twilio starts streaming the caller's audio before the OpenAI
    // handshake completes; dropping those frames loses the caller's
    // opening "Hello?" and the agent sits silent until they speak again.
    const { client, fake } = build();
    fake.readyState = 0; // CONNECTING
    client.appendAudio("EARLY-1");
    client.appendAudio("EARLY-2");
    expect(fake.received).toHaveLength(0); // nothing sent while connecting
    fake.readyState = 1;
    fake.fakeOpen();
    const types = fake.received.map(
      (r) => (JSON.parse(r) as { type: string }).type,
    );
    // session.update FIRST, then the buffered audio in arrival order.
    expect(types).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
    ]);
    expect(
      fake.received
        .slice(1)
        .map((r) => (JSON.parse(r) as { audio: string }).audio),
    ).toEqual(["EARLY-1", "EARLY-2"]);
  });

  it("caps the pre-open audio buffer (drops oldest first)", () => {
    const { client, fake } = build();
    fake.readyState = 0;
    for (let i = 0; i < 260; i += 1) client.appendAudio(`F${i}`);
    fake.readyState = 1;
    fake.fakeOpen();
    const audio = fake.received
      .slice(1)
      .map((r) => (JSON.parse(r) as { audio: string }).audio);
    expect(audio).toHaveLength(250); // MAX_PRE_OPEN_AUDIO_FRAMES
    expect(audio[0]).toBe("F10"); // oldest 10 dropped
    expect(audio[audio.length - 1]).toBe("F259");
  });

  it("submitToolResult with requestFollowUp:false does NOT request a response", () => {
    const { client, fake } = build();
    fake.fakeOpen();
    fake.received.length = 0;
    client.submitToolResult(
      "call_end",
      { ok: true },
      {
        requestFollowUp: false,
      },
    );
    expect(fake.received).toHaveLength(1);
    expect(JSON.parse(fake.received[0]!).type).toBe("conversation.item.create");
  });

  it("submitToolResult round-trips the call id and stringifies the result, then requests a follow-up response", () => {
    const { client, fake } = build();
    fake.fakeOpen();
    fake.received.length = 0;
    client.submitToolResult("call_xyz", {
      matched: true,
      attempts_remaining: 2,
    });
    expect(fake.received).toHaveLength(2);
    const created = JSON.parse(fake.received[0]!);
    expect(created.type).toBe("conversation.item.create");
    expect(created.item.type).toBe("function_call_output");
    expect(created.item.call_id).toBe("call_xyz");
    expect(JSON.parse(created.item.output)).toEqual({
      matched: true,
      attempts_remaining: 2,
    });
    const create = JSON.parse(fake.received[1]!);
    expect(create).toEqual({ type: "response.create" });
  });

  it("close() emits 'closed' with the supplied code and reason", () => {
    const { client, fake } = build();
    const seen: { code: number; reason: string }[] = [];
    client.on("closed", (i) => seen.push(i));
    fake.fakeOpen();
    client.close(1011, "upstream_failure");
    expect(seen).toEqual([{ code: 1011, reason: "upstream_failure" }]);
  });

  it("does NOT auto-reconnect on socket close (one call = one socket)", () => {
    const { client, fake } = build();
    const reopens: string[] = [];
    client.on("open", () => reopens.push("open"));
    fake.fakeOpen();
    expect(reopens).toEqual(["open"]);
    fake.emit("close", 1006, Buffer.from("network"));
    // No new send/open should occur after close.
    expect(reopens).toEqual(["open"]);
  });

  it("does not crash on an unknown event type — silently ignores", () => {
    const { client, fake } = build();
    const errors: string[] = [];
    client.on("error", (e) => errors.push(e.code));
    fake.fakeOpen();
    fake.fakeMessage({ type: "some.future.event", foo: "bar" });
    expect(errors).toEqual([]);
  });
});
