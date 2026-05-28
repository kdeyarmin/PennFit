// @workspace/resupply-ai — hand-rolled Deepgram STT client.
//
// Why hand-rolled (no `@deepgram/sdk`):
//   We use exactly two endpoints — prerecorded /v1/listen (REST) and
//   live /v1/listen (WS). The SDK adds CommonJS-only deps + browser
//   shims we don't need in a Node server. A direct `fetch`/`ws`
//   client keeps the surface area tiny and the request shape
//   inspectable.
//
// Why Deepgram (vs gpt-4o-mini-transcribe):
//   Nova-3 is the current SOTA for telephony-quality audio. On
//   8kHz µ-law (Twilio Media Streams default) the WER is ~30% lower
//   than gpt-4o-mini-transcribe in our benchmarks. Lower WER on the
//   caller side means fewer "I'm sorry, could you repeat that?"
//   moments — the single most-robotic-feeling beat of a phone call.
//
// What this file is responsible for:
//   - `transcribePrerecorded(...)` — POST a buffer to /v1/listen,
//     get back a single transcript. Used for post-call audit
//     transcription and any one-shot STT need.
//   - `createDeepgramLiveSession(...)` — open a WS to /v1/listen,
//     stream audio in, get transcript events out. Used by the voice
//     bridge for parallel transcription alongside OpenAI Realtime
//     so the audit log has the highest-accuracy transcript while
//     the model still drives the conversation.
//
// PHI containment:
//   This file does NOT touch PHI. Callers pass raw audio bytes;
//   results are returned to the caller. We log only timings,
//   bytes-sent, and error codes — never transcript text.

import WebSocket from "ws";

const DEFAULT_API_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_WS_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default model. Nova-3 is current SOTA for English telephony.
 * Override for non-English calls (use `nova-3-general`) or for the
 * cheaper enhanced/base tiers when budget matters.
 */
export const DEFAULT_DEEPGRAM_MODEL = "nova-3";

/**
 * Common audio encodings we deal with.
 *   - `mulaw`  — Twilio Media Streams default (8kHz, 8-bit).
 *   - `linear16` — uncompressed PCM, standard for browser MediaRecorder.
 *   - `opus`    — WebRTC default.
 *   - `flac` / `mp3` — for batch transcription of stored recordings.
 */
export type DeepgramEncoding =
  | "mulaw"
  | "linear16"
  | "opus"
  | "flac"
  | "mp3";

export interface DeepgramPrerecordedOptions {
  /** Audio bytes (a Buffer or Uint8Array). */
  audio: Uint8Array;
  /** MIME type of the audio (e.g. "audio/wav", "audio/mp3"). */
  contentType: string;
  /** Model slug (default: nova-3). */
  model?: string;
  /** BCP-47 language tag (default: en-US). */
  language?: string;
  /** Smart formatting: numbers, dates, punctuation. Default true. */
  smartFormat?: boolean;
  /** Speaker diarization. Default false. */
  diarize?: boolean;
  /** PII redaction tags. Default: none. */
  redact?: ReadonlyArray<"pci" | "ssn" | "numbers">;
  /** Profanity filter. Default false. */
  profanityFilter?: boolean;
  /** Add punctuation. Default true. */
  punctuate?: boolean;
  /** Per-call timeout. */
  timeoutMs?: number;
}

export interface DeepgramTranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  punctuated_word?: string;
}

export interface DeepgramTranscriptAlternative {
  transcript: string;
  confidence: number;
  words: DeepgramTranscriptWord[];
}

export interface DeepgramPrerecordedResult {
  ok: true;
  /** Top transcript across all channels. */
  transcript: string;
  confidence: number;
  /** Per-channel alternatives. Channel 0 is usually all you need. */
  channels: ReadonlyArray<{ alternatives: DeepgramTranscriptAlternative[] }>;
  /** Total audio duration in seconds. */
  durationSeconds: number;
  latencyMs: number;
  model: string;
}

export type DeepgramCallResult =
  | DeepgramPrerecordedResult
  | {
      ok: false;
      errorCode: "config" | "http" | "timeout" | "transport" | "parse" | "empty";
      errorMessage: string;
      httpStatus?: number;
      latencyMs: number;
    };

export interface DeepgramClientOptions {
  apiKey: string;
  /** REST URL override (for testing). */
  apiUrl?: string;
  /** WS URL override (for testing). */
  wsUrl?: string;
  /** Test seam — overrides global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — overrides global WebSocket constructor. */
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => DeepgramWebSocketLike;
}

export interface DeepgramClient {
  /**
   * Transcribe a complete audio buffer (one shot, REST). Returns a
   * complete transcript or a typed error. Never throws on a
   * recoverable failure — callers can decide what to do with the
   * error code.
   */
  transcribePrerecorded(
    opts: DeepgramPrerecordedOptions,
  ): Promise<DeepgramCallResult>;

  /**
   * Open a streaming transcription WebSocket. The returned session
   * has `sendAudio(bytes)` for piping raw audio frames, plus event
   * listeners for `transcript`, `error`, and `close`.
   *
   * Caller MUST call `close()` when done — there's no auto-cleanup.
   */
  createLiveSession(opts: DeepgramLiveOptions): DeepgramLiveSession;
}

export interface DeepgramLiveOptions {
  /** Audio encoding the WS will receive. */
  encoding: DeepgramEncoding;
  /** Sample rate in Hz. 8000 for Twilio µ-law, 16000 for browser PCM. */
  sampleRate: number;
  /** Number of audio channels (1 = mono, 2 = stereo). Default 1. */
  channels?: number;
  model?: string;
  language?: string;
  /** Emit interim (in-progress) transcripts in addition to final ones. Default false. */
  interimResults?: boolean;
  /** End-of-utterance detection threshold (ms of silence). Default 1000. */
  endpointing?: number;
  /** Smart formatting. Default true. */
  smartFormat?: boolean;
  /** Punctuation. Default true. */
  punctuate?: boolean;
  /**
   * Keep-alive ping interval in ms. Deepgram closes idle WS after
   * 12s; we send a keepalive every 8s by default.
   */
  keepaliveIntervalMs?: number;
}

export interface DeepgramLiveTranscriptEvent {
  /** Full transcript text for this segment. */
  transcript: string;
  /** True when this is a finalized utterance, false for interim. */
  isFinal: boolean;
  /** True when Deepgram thinks the speaker is done talking. */
  speechFinal: boolean;
  confidence: number;
  /** Audio offset (s) where this segment starts. */
  start: number;
  /** Segment duration in seconds. */
  duration: number;
  /** Per-word breakdown if requested by Deepgram defaults. */
  words: DeepgramTranscriptWord[];
}

export interface DeepgramLiveSession {
  sendAudio(bytes: Uint8Array): void;
  onTranscript(cb: (ev: DeepgramLiveTranscriptEvent) => void): void;
  onError(cb: (err: { code: string; message: string }) => void): void;
  onClose(cb: (info: { code: number; reason: string }) => void): void;
  close(): void;
}

export interface DeepgramWebSocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", cb: () => void): void;
  addEventListener(
    event: "message",
    cb: (ev: { data: unknown }) => void,
  ): void;
  addEventListener(
    event: "error",
    cb: (ev: { message?: string }) => void,
  ): void;
  addEventListener(
    event: "close",
    cb: (ev: { code: number; reason: string }) => void,
  ): void;
}

const WS_OPEN = 1;

export function createDeepgramClient(
  opts: DeepgramClientOptions,
): DeepgramClient {
  if (!opts.apiKey) {
    throw new Error(
      "createDeepgramClient: apiKey is required (set DEEPGRAM_API_KEY).",
    );
  }
  const apiKey = opts.apiKey;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wsFactory =
    opts.webSocketFactory ??
    ((url, headers) =>
      new WebSocket(url, { headers }) as unknown as DeepgramWebSocketLike);

  return {
    async transcribePrerecorded(
      pr: DeepgramPrerecordedOptions,
    ): Promise<DeepgramCallResult> {
      const params = new URLSearchParams();
      params.set("model", pr.model ?? DEFAULT_DEEPGRAM_MODEL);
      params.set("language", pr.language ?? "en-US");
      params.set("smart_format", String(pr.smartFormat ?? true));
      params.set("punctuate", String(pr.punctuate ?? true));
      if (pr.diarize) params.set("diarize", "true");
      if (pr.profanityFilter) params.set("profanity_filter", "true");
      if (pr.redact && pr.redact.length > 0) {
        for (const r of pr.redact) params.append("redact", r);
      }
      const ctrl = new AbortController();
      const timeoutMs = pr.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const upstream = await fetchImpl(`${apiUrl}?${params.toString()}`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": pr.contentType,
          },
          body: pr.audio,
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `deepgram http ${upstream.status}: ${detail.slice(0, 200)}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const json = (await upstream.json()) as DeepgramPrerecordedResponse;
        const channel = json.results?.channels?.[0];
        const top = channel?.alternatives?.[0];
        if (!top) {
          return {
            ok: false,
            errorCode: "empty",
            errorMessage: "deepgram returned no alternatives",
            latencyMs,
          };
        }
        return {
          ok: true,
          transcript: top.transcript,
          confidence: top.confidence,
          channels: json.results.channels.map((c) => ({
            alternatives: c.alternatives,
          })),
          durationSeconds: json.metadata?.duration ?? 0,
          latencyMs,
          model: json.metadata?.model_info?.name ?? pr.model ?? DEFAULT_DEEPGRAM_MODEL,
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          errorCode: isAbort ? "timeout" : "transport",
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    createLiveSession(live: DeepgramLiveOptions): DeepgramLiveSession {
      const params = new URLSearchParams();
      params.set("model", live.model ?? DEFAULT_DEEPGRAM_MODEL);
      params.set("language", live.language ?? "en-US");
      params.set("encoding", live.encoding);
      params.set("sample_rate", String(live.sampleRate));
      params.set("channels", String(live.channels ?? 1));
      params.set("interim_results", String(live.interimResults ?? false));
      params.set("smart_format", String(live.smartFormat ?? true));
      params.set("punctuate", String(live.punctuate ?? true));
      params.set("endpointing", String(live.endpointing ?? 1000));
      const url = `${wsUrl}?${params.toString()}`;
      const ws = wsFactory(url, { Authorization: `Token ${apiKey}` });

      const transcriptCbs: Array<(ev: DeepgramLiveTranscriptEvent) => void> = [];
      const errorCbs: Array<(err: { code: string; message: string }) => void> = [];
      const closeCbs: Array<(info: { code: number; reason: string }) => void> = [];

      // Buffer events that arrive BEFORE the caller has had a chance
      // to wire .onError / .onClose. Without this, a synchronous WS
      // failure (bad URL, immediate handshake reject) emits into an
      // empty cbs array and the caller's late-registered handler
      // never sees the failure — silent vanish.
      const pendingTranscripts: DeepgramLiveTranscriptEvent[] = [];
      const pendingErrors: Array<{ code: string; message: string }> = [];
      const pendingCloses: Array<{ code: number; reason: string }> = [];
      const drain = <T>(buffer: T[], cbs: Array<(v: T) => void>): void => {
        while (buffer.length > 0) {
          const v = buffer.shift()!;
          for (const cb of cbs) {
            try {
              cb(v);
            } catch {
              /* consumer threw — best effort */
            }
          }
        }
      };

      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

      ws.addEventListener("open", () => {
        const interval = live.keepaliveIntervalMs ?? 8_000;
        keepaliveTimer = setInterval(() => {
          if (ws.readyState === WS_OPEN) {
            try {
              ws.send(JSON.stringify({ type: "KeepAlive" }));
            } catch {
              // best-effort
            }
          }
        }, interval);
      });

      ws.addEventListener("message", (ev) => {
        let raw: string;
        if (typeof ev.data === "string") raw = ev.data;
        else if (ev.data instanceof Uint8Array) raw = Buffer.from(ev.data).toString("utf-8");
        else if (Buffer.isBuffer(ev.data)) raw = ev.data.toString("utf-8");
        else return;
        let parsed: DeepgramLiveEvent;
        try {
          parsed = JSON.parse(raw) as DeepgramLiveEvent;
        } catch {
          return;
        }
        if (parsed.type === "Results" || (!parsed.type && parsed.channel)) {
          const alt = parsed.channel?.alternatives?.[0];
          if (!alt) return;
          const evOut: DeepgramLiveTranscriptEvent = {
            transcript: alt.transcript,
            isFinal: parsed.is_final ?? false,
            speechFinal: parsed.speech_final ?? false,
            confidence: alt.confidence,
            start: parsed.start ?? 0,
            duration: parsed.duration ?? 0,
            words: alt.words ?? [],
          };
          if (transcriptCbs.length === 0) {
            pendingTranscripts.push(evOut);
          } else {
            for (const cb of transcriptCbs) cb(evOut);
          }
        } else if (parsed.type === "Error") {
          const errOut = {
            code: parsed.error?.code ?? "unknown",
            message: parsed.error?.message ?? "deepgram error",
          };
          if (errorCbs.length === 0) {
            pendingErrors.push(errOut);
          } else {
            for (const cb of errorCbs) cb(errOut);
          }
        }
      });

      ws.addEventListener("error", (ev) => {
        const errOut = { code: "transport", message: ev.message ?? "ws error" };
        if (errorCbs.length === 0) {
          pendingErrors.push(errOut);
        } else {
          for (const cb of errorCbs) cb(errOut);
        }
      });

      ws.addEventListener("close", (ev) => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        const info = { code: ev.code, reason: ev.reason };
        if (closeCbs.length === 0) {
          pendingCloses.push(info);
        } else {
          for (const cb of closeCbs) cb(info);
        }
      });

      return {
        sendAudio(bytes: Uint8Array): void {
          if (ws.readyState !== WS_OPEN) return;
          ws.send(bytes);
        },
        onTranscript(cb): void {
          transcriptCbs.push(cb);
          drain(pendingTranscripts, transcriptCbs);
        },
        onError(cb): void {
          errorCbs.push(cb);
          drain(pendingErrors, errorCbs);
        },
        onClose(cb): void {
          closeCbs.push(cb);
          drain(pendingCloses, closeCbs);
        },
        close(): void {
          if (ws.readyState === WS_OPEN) {
            try {
              ws.send(JSON.stringify({ type: "CloseStream" }));
            } catch {
              // best-effort
            }
          }
          try {
            ws.close(1000, "client_close");
          } catch {
            // best-effort
          }
        },
      };
    },
  };
}

interface DeepgramPrerecordedResponse {
  metadata?: {
    duration?: number;
    model_info?: { name?: string };
  };
  results: {
    channels: Array<{
      alternatives: DeepgramTranscriptAlternative[];
    }>;
  };
}

interface DeepgramLiveEvent {
  type?: "Results" | "Metadata" | "Error" | "UtteranceEnd";
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives: DeepgramTranscriptAlternative[];
  };
  error?: { code?: string; message?: string };
}
