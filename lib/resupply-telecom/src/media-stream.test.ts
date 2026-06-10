import { describe, expect, it } from "vitest";

import {
  encodeClearFrame,
  encodeMarkFrame,
  encodeMediaFrame,
  parseTwilioFrame,
} from "./media-stream";

describe("parseTwilioFrame — happy paths", () => {
  it("parses a 'connected' handshake frame", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "connected",
        protocol: "Call",
        version: "1.0.0",
      }),
    );
    expect(frame?.event).toBe("connected");
  });

  it("parses the REAL documented 'start' frame shape (tracks + accountSid + sequenceNumber)", () => {
    // Regression guard: the start frame Twilio actually sends carries
    // `tracks` (and other fields we don't read). The schemas used to be
    // .strict(), so this exact production payload was rejected — the
    // start frame was dropped, streamSid was never captured, and every
    // byte of agent audio was silently discarded (a fully silent call).
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          accountSid: "AC0000000000000000000000000000cafe",
          streamSid: "MZ0000000000000000000000000000abcd",
          callSid: "CA0000000000000000000000000000beef",
          tracks: ["inbound"],
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
          customParameters: {
            conversationId: "11111111-1111-1111-1111-111111111111",
          },
        },
        streamSid: "MZ0000000000000000000000000000abcd",
      }),
    );
    expect(frame).toBeTruthy();
    if (frame?.event !== "start") throw new Error("expected start frame");
    expect(frame.start.streamSid).toBe("MZ0000000000000000000000000000abcd");
    expect(frame.start.callSid).toBe("CA0000000000000000000000000000beef");
  });

  it("tolerates unknown extra fields on known events (Twilio adds fields out of band)", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "media",
        sequenceNumber: "4",
        streamSid: "MZxxxx",
        someFutureField: { nested: true },
        media: {
          track: "inbound",
          chunk: "2",
          timestamp: "5",
          payload: "AAAA",
          anotherFutureField: 1,
        },
      }),
    );
    expect(frame).toBeTruthy();
    if (frame?.event !== "media") throw new Error("expected media frame");
    expect(frame.media.payload).toBe("AAAA");
  });

  it("parses a 'start' frame and exposes the customParameters", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: "MZ0000000000000000000000000000abcd",
        start: {
          streamSid: "MZ0000000000000000000000000000abcd",
          callSid: "CA0000000000000000000000000000beef",
          customParameters: {
            conversationId: "11111111-1111-1111-1111-111111111111",
          },
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
        },
      }),
    );
    expect(frame).toBeTruthy();
    if (frame?.event !== "start") throw new Error("expected start frame");
    expect(frame.start.customParameters?.conversationId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(frame.start.callSid).toBe("CA0000000000000000000000000000beef");
  });

  it("parses a 'media' frame and exposes the base64 payload", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "media",
        sequenceNumber: "5",
        streamSid: "MZxxxx",
        media: {
          track: "inbound",
          chunk: "1",
          timestamp: "20",
          payload: "SGVsbG8=",
        },
      }),
    );
    if (frame?.event !== "media") throw new Error("expected media frame");
    expect(frame.media.payload).toBe("SGVsbG8=");
  });

  it("parses a 'mark' frame", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "mark",
        sequenceNumber: "6",
        streamSid: "MZxxxx",
        mark: { name: "agent_greeting_done" },
      }),
    );
    if (frame?.event !== "mark") throw new Error("expected mark frame");
    expect(frame.mark.name).toBe("agent_greeting_done");
  });

  it("parses a 'stop' frame (with stop nested optional)", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "stop",
        sequenceNumber: "9",
        streamSid: "MZxxxx",
      }),
    );
    expect(frame?.event).toBe("stop");
  });

  it("accepts a Buffer input (the WS server's default frame type)", () => {
    const frame = parseTwilioFrame(
      Buffer.from(JSON.stringify({ event: "connected" }), "utf8"),
    );
    expect(frame?.event).toBe("connected");
  });
});

describe("parseTwilioFrame — sad paths", () => {
  it("returns null for non-JSON garbage rather than throwing", () => {
    expect(parseTwilioFrame("not json {{{")).toBeNull();
  });

  it("returns null for an unknown event type (forward-compat with future Twilio kinds)", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({ event: "future_unknown_event", payload: "x" }),
    );
    expect(frame).toBeNull();
  });

  it("returns null for a 'start' frame missing required fields", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({ event: "start", streamSid: "MZxxxx" }),
    );
    expect(frame).toBeNull();
  });

  it("returns null for a 'media' frame missing the payload", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "media",
        streamSid: "MZxxxx",
        media: { track: "inbound" },
      }),
    );
    expect(frame).toBeNull();
  });
});

describe("encoders", () => {
  it("encodeMediaFrame produces the exact shape Twilio expects", () => {
    const raw = encodeMediaFrame("MZxxxx", "AAAA");
    expect(JSON.parse(raw)).toEqual({
      event: "media",
      streamSid: "MZxxxx",
      media: { payload: "AAAA" },
    });
  });

  it("encodeMarkFrame includes the mark name", () => {
    const raw = encodeMarkFrame("MZxxxx", "agent_greeting_done");
    expect(JSON.parse(raw)).toEqual({
      event: "mark",
      streamSid: "MZxxxx",
      mark: { name: "agent_greeting_done" },
    });
  });

  it("encodeClearFrame is the canonical barge-in payload", () => {
    const raw = encodeClearFrame("MZxxxx");
    expect(JSON.parse(raw)).toEqual({ event: "clear", streamSid: "MZxxxx" });
  });
});
