// @workspace/resupply-telecom — Twilio Media Streams protocol parser/encoder.
//
// Twilio's Media Streams send/receive newline-delimited JSON over a
// single WebSocket. The five event kinds we care about:
//
//   - `connected`  — protocol handshake. Trivial; we ack by ignoring.
//   - `start`      — call metadata: streamSid, callSid, customParameters.
//                    Arrives ONCE, FIRST after `connected`. Parse and
//                    capture the streamSid (we need it on every outbound
//                    `media` frame).
//   - `media`      — base64 µ-law @ 8kHz, ~20ms per frame, sequenced.
//                    Forward to the model; sequence numbers are
//                    advisory.
//   - `mark`       — playback marker we emit to know when our queued
//                    audio finished playing on the caller's end. Useful
//                    for barge-in handling.
//   - `stop`       — call ended. Tear down our side.
//
// Everything else (any new event Twilio adds) we silently ignore so a
// server-side rollout can't break the bridge.
//
// Why zod for the inbound parse: we get a typed discriminated union for
// free, and a `safeParse` failure becomes "ignore frame, log shape" —
// the bridge stays up.
//
// Tolerance posture: the schemas validate the fields we READ and strip
// everything else (zod's default object behaviour). They are
// deliberately NOT `.strict()`: Twilio's real payloads carry fields we
// don't use (`start.tracks`, per-frame `sequenceNumber`, …) and adds
// more out of band — a strict schema turned the documented
// `start.tracks` field into a dropped start frame in production, which
// meant `streamSid` was never captured and every byte of agent audio
// was silently discarded (a fully silent call). Unknown fields must
// never invalidate a known event.

import { z } from "zod";

// ---- Inbound frame schemas -----------------------------------------------

const connectedFrameSchema = z.object({
  event: z.literal("connected"),
  protocol: z.string().optional(),
  version: z.string().optional(),
});

const startFrameSchema = z.object({
  event: z.literal("start"),
  sequenceNumber: z.string().optional(),
  streamSid: z.string().min(1),
  start: z.object({
    streamSid: z.string().min(1),
    callSid: z.string().min(1),
    accountSid: z.string().min(1).optional(),
    // Which audio tracks the stream carries ("inbound" for the
    // caller-side stream we request). Present in every real start
    // frame; we don't branch on it but accept it explicitly.
    tracks: z.array(z.string()).optional(),
    // Custom parameters set in the TwiML `<Stream>` block. Twilio
    // sends them as a flat Record<string,string>.
    customParameters: z.record(z.string(), z.string()).optional(),
    mediaFormat: z
      .object({
        encoding: z.string(),
        sampleRate: z.number().int(),
        channels: z.number().int(),
      })
      .optional(),
  }),
});

const mediaFrameSchema = z.object({
  event: z.literal("media"),
  sequenceNumber: z.string().optional(),
  streamSid: z.string().min(1),
  media: z.object({
    track: z.string().optional(),
    chunk: z.string().optional(),
    timestamp: z.string().optional(),
    payload: z.string().min(1),
  }),
});

const markFrameSchema = z.object({
  event: z.literal("mark"),
  sequenceNumber: z.string().optional(),
  streamSid: z.string().min(1),
  mark: z.object({ name: z.string().min(1) }),
});

const stopFrameSchema = z.object({
  event: z.literal("stop"),
  sequenceNumber: z.string().optional(),
  streamSid: z.string().min(1),
  stop: z
    .object({
      accountSid: z.string().optional(),
      callSid: z.string().optional(),
    })
    .optional(),
});

const inboundFrameSchema = z.discriminatedUnion("event", [
  connectedFrameSchema,
  startFrameSchema,
  mediaFrameSchema,
  markFrameSchema,
  stopFrameSchema,
]);

export type TwilioInboundFrame = z.infer<typeof inboundFrameSchema>;

/**
 * Parse a single inbound Twilio Media Stream frame.
 *
 * Returns the typed discriminated union on success, or `null` on:
 *   - non-JSON payloads,
 *   - unknown / future event types,
 *   - missing required fields.
 *
 * The bridge LOGs and IGNORES nulls; it does NOT close the socket.
 * Twilio is allowed to ship new event types out of band; that
 * shouldn't take down a live call.
 */
export function parseTwilioFrame(
  raw: Buffer | ArrayBuffer | string,
): TwilioInboundFrame | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else {
    text = raw.toString("utf8");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = inboundFrameSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ---- Outbound encoders ---------------------------------------------------
//
// We only ever send three kinds of frames:
//   1. `media` — agent audio chunks back to the caller.
//   2. `mark`  — name we'll see echoed back when the caller hears it.
//                Useful for "did the agent's prompt actually finish
//                playing before the caller talked?".
//   3. `clear` — drop everything queued (barge-in handling).

export interface OutboundMediaFrame {
  event: "media";
  streamSid: string;
  media: { payload: string };
}

export function encodeMediaFrame(
  streamSid: string,
  base64Mulaw: string,
): string {
  const frame: OutboundMediaFrame = {
    event: "media",
    streamSid,
    media: { payload: base64Mulaw },
  };
  return JSON.stringify(frame);
}

export interface OutboundMarkFrame {
  event: "mark";
  streamSid: string;
  mark: { name: string };
}

export function encodeMarkFrame(streamSid: string, name: string): string {
  const frame: OutboundMarkFrame = {
    event: "mark",
    streamSid,
    mark: { name },
  };
  return JSON.stringify(frame);
}

export interface OutboundClearFrame {
  event: "clear";
  streamSid: string;
}

export function encodeClearFrame(streamSid: string): string {
  const frame: OutboundClearFrame = { event: "clear", streamSid };
  return JSON.stringify(frame);
}
