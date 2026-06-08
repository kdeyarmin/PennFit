// @workspace/resupply-ai — ElevenLabs input-streaming (stream-input) WS client.
//
// Why this exists alongside the HTTP `elevenlabs-client.ts`:
//   The HTTP `streamTextToSpeech` endpoint synthesises ONE complete text
//   string per request — so on a live call we either wait for the whole
//   agent turn (high latency) or fire a separate request per sentence
//   (a fresh TLS handshake + cold prosody per fragment). The
//   `stream-input` WebSocket instead keeps ONE connection open for a
//   whole agent turn: we feed text in as the model generates it and
//   audio streams back as it's produced. That pipelines model-generation
//   against synthesis (lowest time-to-first-word) AND lets ElevenLabs
//   carry prosody across sentence boundaries within the turn (the HTTP
//   per-sentence path can't). This is the "best fluidity" path.
//
// Protocol (https://elevenlabs.io/docs — Text-to-Speech streaming input):
//   - URL: wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input
//          ?model_id={model}&output_format={ulaw_8000}
//   - Auth: `xi-api-key` request header on the handshake.
//   - First (BOS) message initialises the stream and carries
//     `voice_settings` + `generation_config` (the chunk_length_schedule
//     that trades latency vs. prosody).
//   - Then: `{ "text": "<chunk> " }` per text delta.
//   - `{ "text": " ", "flush": true }` nudges generation of buffered text
//     immediately (we send it at sentence boundaries for snappy audio).
//   - `{ "text": "" }` is end-of-stream: finish generating, then close.
//   - Server → `{ "audio": "<base64>", "isFinal": … }`. `audio` is base64
//     in the requested output_format (ulaw_8000 = exactly Twilio's wire
//     format). Chunk boundaries are arbitrary; the caller re-frames.
//
// Robustness posture: `flush`/EOS are LATENCY optimisations — audio is
// delivered via the `audio` field and generation is driven by
// `chunk_length_schedule` regardless, and a turn's audio is flushed on
// socket close. So a minor protocol mismatch degrades to slightly higher
// latency, never to a broken/silent call. A hard failure surfaces via
// `onError` (the bridge drops that turn's audio without ending the call).
//
// What this file is NOT responsible for:
//   - Re-framing to 160-byte µ-law frames (the ws-handler adapter does it,
//     same as the HTTP path).
//   - PHI: the synthesised text is patient-facing speech; we never log the
//     text or the audio bytes here.

import WebSocket from "ws";

import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
  type ElevenLabsOutputFormat,
  type ElevenLabsVoiceSettings,
} from "./elevenlabs-client";

const DEFAULT_WS_URL = "wss://api.elevenlabs.io/v1";
const WS_OPEN = 1;

// ElevenLabs' recommended chunk schedule: synthesise after ~120 chars,
// then progressively larger windows. Small first window = fast first
// audio; larger later windows = smoother prosody once the caller is
// already hearing speech.
const DEFAULT_CHUNK_LENGTH_SCHEDULE: readonly number[] = [120, 160, 250, 290];

/**
 * Minimal subset of `ws.WebSocket` we depend on — narrowed so tests can
 * pass a fake without implementing the whole surface (mirrors the
 * `WebSocketLike` pattern in `realtime-client.ts`).
 */
export interface ElevenLabsStreamWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | string) => void,
  ): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

export interface ElevenLabsStreamHandlers {
  /** Base64 audio in the requested output_format (ulaw_8000), as it arrives. */
  onAudioBase64: (audioBase64: string) => void;
  /** Vendor/transport error. The consumer drops the turn's audio; never fatal. */
  onError: (err: { code: string; message: string }) => void;
  /**
   * Fired exactly once when the stream finishes (server `isFinal` or the
   * socket closing on its own) — NOT on an explicit `abort()`, where the
   * consumer is tearing down deliberately and wants no trailing flush.
   */
  onClosed?: () => void;
}

export interface ElevenLabsStreamOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  /** Defaults to `ulaw_8000` (Twilio's native wire format). */
  outputFormat?: ElevenLabsOutputFormat;
  voiceSettings?: ElevenLabsVoiceSettings;
  /** Override the latency/prosody chunk schedule. */
  chunkLengthSchedule?: readonly number[];
  /** Base ws origin override (tests / self-host). Default ElevenLabs. */
  apiUrl?: string;
  /** WS factory — tests pass a fake; production leaves undefined. */
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => ElevenLabsStreamWebSocketLike;
}

/**
 * A single streaming-synthesis session for ONE agent turn. Text is pushed
 * as the model generates it; `end()` signals no-more-text; `abort()` tears
 * down immediately (barge-in / call close).
 */
export interface ElevenLabsStreamSession {
  /** Append a chunk of text to synthesise. No-op after end/abort. */
  pushText(text: string): void;
  /** Nudge ElevenLabs to generate buffered text now (latency). */
  flush(): void;
  /** End-of-stream: finish generating buffered text, then close. */
  end(): void;
  /** Abort immediately; stop sending and suppress the closed callback. */
  abort(): void;
}

/**
 * Open a stream-input session. Returns immediately; the socket connects in
 * the background and any text pushed before it opens is queued and flushed
 * on open (so the caller never has to wait for the handshake).
 */
export function openElevenLabsStream(
  opts: ElevenLabsStreamOptions,
  handlers: ElevenLabsStreamHandlers,
): ElevenLabsStreamSession {
  if (!opts.apiKey) {
    throw new Error(
      "openElevenLabsStream: apiKey is required (set ELEVENLABS_API_KEY).",
    );
  }

  const voiceId = opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = opts.modelId ?? DEFAULT_ELEVENLABS_MODEL;
  const outputFormat = opts.outputFormat ?? "ulaw_8000";
  const apiUrl = opts.apiUrl ?? DEFAULT_WS_URL;
  const url =
    `${apiUrl}/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
    `?model_id=${encodeURIComponent(modelId)}` +
    `&output_format=${encodeURIComponent(outputFormat)}`;
  const headers = { "xi-api-key": opts.apiKey };

  let aborted = false;
  let opened = false;
  let closedEmitted = false;
  // Buffer text/intents that arrive before the socket finishes opening so
  // the caller can push immediately without racing the handshake.
  const pendingText: string[] = [];
  let pendingFlush = false;
  let pendingEos = false;

  const ws: ElevenLabsStreamWebSocketLike = opts.webSocketFactory
    ? opts.webSocketFactory(url, headers)
    : (new WebSocket(url, {
        headers,
      }) as unknown as ElevenLabsStreamWebSocketLike);

  const emitClosed = (): void => {
    if (closedEmitted || aborted) return;
    closedEmitted = true;
    handlers.onClosed?.();
  };

  const sendJson = (payload: Record<string, unknown>): void => {
    if (aborted || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      handlers.onError({
        code: "ws_send_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  ws.on("open", () => {
    if (aborted) {
      try {
        ws.close(1000, "aborted");
      } catch {
        /* already closing */
      }
      return;
    }
    opened = true;
    // BOS: initialise the stream with voice settings + chunk schedule.
    const bos: Record<string, unknown> = {
      text: " ",
      generation_config: {
        chunk_length_schedule:
          opts.chunkLengthSchedule ?? DEFAULT_CHUNK_LENGTH_SCHEDULE,
      },
    };
    if (opts.voiceSettings) bos.voice_settings = opts.voiceSettings;
    sendJson(bos);
    // Drain anything queued before open, preserving order: text → flush → eos.
    for (const t of pendingText) sendJson({ text: t });
    pendingText.length = 0;
    if (pendingFlush) {
      sendJson({ text: " ", flush: true });
      pendingFlush = false;
    }
    if (pendingEos) {
      sendJson({ text: "" });
      pendingEos = false;
    }
  });

  ws.on("message", (data) => {
    if (aborted) return;
    let payload: Record<string, unknown>;
    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : data.toString("utf8");
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      handlers.onError({
        code: "invalid_json",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // ElevenLabs surfaces stream errors as a structured `error` field.
    if (typeof payload.error === "string") {
      handlers.onError({
        code: "elevenlabs_error",
        message:
          typeof payload.message === "string" ? payload.message : payload.error,
      });
      return;
    }
    if (typeof payload.audio === "string" && payload.audio.length > 0) {
      handlers.onAudioBase64(payload.audio);
    }
    if (payload.isFinal === true) {
      emitClosed();
    }
  });

  ws.on("error", (err) => {
    if (aborted) return;
    handlers.onError({ code: "ws_error", message: err.message });
  });

  ws.on("close", () => {
    emitClosed();
  });

  return {
    pushText(text: string): void {
      if (aborted || text.length === 0) return;
      if (!opened) {
        pendingText.push(text);
        return;
      }
      sendJson({ text });
    },
    flush(): void {
      if (aborted) return;
      if (!opened) {
        pendingFlush = true;
        return;
      }
      sendJson({ text: " ", flush: true });
    },
    end(): void {
      if (aborted) return;
      if (!opened) {
        pendingEos = true;
        return;
      }
      sendJson({ text: "" });
    },
    abort(): void {
      if (aborted) return;
      aborted = true;
      try {
        ws.close(1000, "aborted");
      } catch {
        /* already closing */
      }
    },
  };
}
