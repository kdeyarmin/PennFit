import { describe, expect, it, vi } from "vitest";

import {
  openElevenLabsStream,
  type ElevenLabsStreamHandlers,
  type ElevenLabsStreamWebSocketLike,
} from "./elevenlabs-stream";

const VALID_KEY = "elevenlabs-fake-test-key-1234567890";

/**
 * Fake WS that records sent payloads and lets the test drive the
 * open/message/error/close lifecycle deterministically. `readyState`
 * starts CONNECTING (0); `simulateOpen()` flips it to OPEN (1) like the
 * real `ws` would before firing "open".
 */
class FakeWs {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.fire("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  // --- test drivers ---
  simulateOpen(): void {
    this.readyState = 1;
    this.fire("open");
  }
  simulateMessage(obj: unknown): void {
    this.fire("message", JSON.stringify(obj));
  }
  simulateError(message: string): void {
    this.fire("error", new Error(message));
  }
  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function setup(
  overrides: Partial<ElevenLabsStreamHandlers> = {},
  opts: { voiceSettings?: Record<string, unknown> } = {},
) {
  const ws = new FakeWs();
  const audio: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const onClosed = vi.fn();
  const handlers: ElevenLabsStreamHandlers = {
    onAudioBase64: (b) => audio.push(b),
    onError: (e) => errors.push(e),
    onClosed,
    ...overrides,
  };
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const session = openElevenLabsStream(
    {
      apiKey: VALID_KEY,
      voiceId: "voiceX",
      modelId: "modelY",
      ...(opts.voiceSettings ? { voiceSettings: opts.voiceSettings } : {}),
      webSocketFactory: (url, headers) => {
        capturedUrl = url;
        capturedHeaders = headers;
        return ws as unknown as ElevenLabsStreamWebSocketLike;
      },
    },
    handlers,
  );
  const sentObjects = () =>
    ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  return {
    ws,
    session,
    audio,
    errors,
    onClosed,
    sentObjects,
    get url() {
      return capturedUrl;
    },
    get headers() {
      return capturedHeaders;
    },
  };
}

describe("openElevenLabsStream", () => {
  it("throws when apiKey is missing", () => {
    expect(() =>
      openElevenLabsStream(
        { apiKey: "" },
        { onAudioBase64: () => {}, onError: () => {} },
      ),
    ).toThrow(/apiKey/);
  });

  it("builds the stream-input URL with model + output format and the xi-api-key header", () => {
    const { url, headers } = setup();
    expect(url).toContain("/text-to-speech/voiceX/stream-input");
    expect(url).toContain("model_id=modelY");
    expect(url).toContain("output_format=ulaw_8000");
    expect(headers["xi-api-key"]).toBe(VALID_KEY);
  });

  it("sends a BOS (voice_settings + chunk schedule) on open, then queued text in order", () => {
    const { ws, session, sentObjects } = setup(
      {},
      {
        voiceSettings: { stability: 0.45, speed: 1.0 },
      },
    );
    // Pushed before the socket opens → queued.
    session.pushText("Hello ");
    expect(ws.sent).toHaveLength(0);

    ws.simulateOpen();
    const sent = sentObjects();
    // BOS first.
    expect(sent[0]).toMatchObject({
      text: " ",
      generation_config: { chunk_length_schedule: expect.any(Array) },
      voice_settings: { stability: 0.45, speed: 1.0 },
    });
    // Then the queued text.
    expect(sent[1]).toEqual({ text: "Hello " });
  });

  it("pushText/flush/end after open send the right frames", () => {
    const { ws, session, sentObjects } = setup();
    ws.simulateOpen();
    session.pushText("How are you? ");
    session.flush();
    session.end();
    const sent = sentObjects().slice(1); // drop BOS
    expect(sent).toEqual([
      { text: "How are you? " },
      { text: " ", flush: true },
      { text: "" },
    ]);
  });

  it("drains a pre-open flush and EOS after open, in order (text → flush → eos)", () => {
    const { ws, session, sentObjects } = setup();
    session.pushText("Hi ");
    session.flush();
    session.end();
    ws.simulateOpen();
    expect(sentObjects().slice(1)).toEqual([
      { text: "Hi " },
      { text: " ", flush: true },
      { text: "" },
    ]);
  });

  it("demuxes audio messages to onAudioBase64", () => {
    const { ws, audio } = setup();
    ws.simulateOpen();
    ws.simulateMessage({ audio: "QUJD", isFinal: false });
    ws.simulateMessage({ audio: "REVG", isFinal: null });
    expect(audio).toEqual(["QUJD", "REVG"]);
  });

  it("fires onClosed exactly once on isFinal, and not again on socket close", () => {
    const { ws, onClosed } = setup();
    ws.simulateOpen();
    ws.simulateMessage({ audio: null, isFinal: true });
    expect(onClosed).toHaveBeenCalledTimes(1);
    ws.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("treats a structured error message as onError (not audio)", () => {
    const { ws, errors, audio } = setup();
    ws.simulateOpen();
    ws.simulateMessage({ error: "quota_exceeded", message: "out of credits" });
    expect(audio).toEqual([]);
    expect(errors).toEqual([
      { code: "elevenlabs_error", message: "out of credits" },
    ]);
  });

  it("surfaces a transport error via onError", () => {
    const { ws, errors } = setup();
    ws.simulateOpen();
    ws.simulateError("socket hang up");
    expect(errors).toEqual([{ code: "ws_error", message: "socket hang up" }]);
  });

  it("abort closes the socket and suppresses further sends + the closed callback", () => {
    const { ws, session, onClosed } = setup();
    ws.simulateOpen();
    const sentBefore = ws.sent.length;
    session.abort();
    expect(ws.closed).not.toBeNull();
    // No further sends after abort.
    session.pushText("ignored");
    session.flush();
    session.end();
    expect(ws.sent).toHaveLength(sentBefore);
    // The deliberate teardown must NOT fire onClosed.
    expect(onClosed).not.toHaveBeenCalled();
  });
});
