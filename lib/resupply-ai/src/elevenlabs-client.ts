// @workspace/resupply-ai — hand-rolled ElevenLabs TTS client.
//
// Why hand-rolled (no `elevenlabs` SDK):
//   The SDK is ~3MB of generated code and pulls in axios. We use two
//   endpoints — /v1/text-to-speech/:voiceId (regular) and
//   /v1/text-to-speech/:voiceId/stream (streaming). Direct `fetch`
//   keeps the request shape inspectable in 30 lines.
//
// Why ElevenLabs:
//   For raw voice naturalness, ElevenLabs is the gold standard as of
//   2026. Their v3 model + "alpha" voices are genuinely
//   indistinguishable from a real person in casual listening tests.
//   For patients who are elderly, anxious, or hearing-impaired, the
//   warmer-than-OpenAI-marin voices noticeably improve trust.
//
// Integration shape:
//   This client returns raw audio bytes. The voice bridge is
//   responsible for transcoding to Twilio's µ-law @ 8kHz format
//   (ElevenLabs natively outputs PCM 16-bit at various sample
//   rates or µ-law @ 8kHz directly via the `output_format` param).
//
// PHI containment:
//   This file does NOT touch PHI directly. The caller is responsible
//   for not putting PHI into TTS text — but in practice, voice agent
//   responses ARE patient-facing speech, so the text we synthesize
//   IS PHI by definition. ElevenLabs offers a BAA for HIPAA usage
//   on their Enterprise tier; verify the BAA is in place before
//   wiring this into a production call path.

const DEFAULT_API_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Recommended defaults — Eleven Multilingual v2 is the most stable
 * across English accents. v3 (alpha) offers better prosody but is
 * not yet GA. Override per call when needed.
 */
export const DEFAULT_ELEVENLABS_MODEL = "eleven_turbo_v2_5";

/**
 * "Rachel" — ElevenLabs' default warm female voice. Good neutral
 * starting point for CPAP demographic (skews older, mixed gender).
 * Swap with any voice ID from the ElevenLabs voice library.
 */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * Audio output formats ElevenLabs supports. For Twilio Media Streams
 * (µ-law 8kHz), use `ulaw_8000`. For browser playback, prefer
 * `mp3_44100_128`.
 */
export type ElevenLabsOutputFormat =
  | "mp3_22050_32"
  | "mp3_44100_32"
  | "mp3_44100_64"
  | "mp3_44100_96"
  | "mp3_44100_128"
  | "mp3_44100_192"
  | "pcm_16000"
  | "pcm_22050"
  | "pcm_24000"
  | "pcm_44100"
  | "ulaw_8000";

export interface ElevenLabsVoiceSettings {
  /** 0..1 — higher = more consistent across renders, lower = more emotional variation. */
  stability?: number;
  /** 0..1 — how close to the original voice character to stay. */
  similarity_boost?: number;
  /** 0..1 — exaggeration of speaking style. Higher costs more latency. */
  style?: number;
  /** Whether to boost speaker clarity at slight latency cost. */
  use_speaker_boost?: boolean;
  /** 0.7..1.2 — playback speed multiplier. 1.0 = natural. */
  speed?: number;
}

export interface ElevenLabsTtsInput {
  /** Text to synthesize. Max ~5000 chars per request. */
  text: string;
  /** Voice ID. Defaults to DEFAULT_ELEVENLABS_VOICE_ID. */
  voiceId?: string;
  /** Model ID. Defaults to DEFAULT_ELEVENLABS_MODEL. */
  modelId?: string;
  /** Output audio format. Defaults to mp3_44100_128. */
  outputFormat?: ElevenLabsOutputFormat;
  /** Voice tuning. */
  voiceSettings?: ElevenLabsVoiceSettings;
  /** Optional language code (BCP-47). Helps disambiguate accented English. */
  languageCode?: string;
  timeoutMs?: number;
}

export interface ElevenLabsTtsResult {
  ok: true;
  /** Raw audio bytes in the requested `outputFormat`. */
  audio: Uint8Array;
  /** Reported by the response Content-Type. */
  contentType: string;
  latencyMs: number;
}

export type ElevenLabsCallResult =
  | ElevenLabsTtsResult
  | {
      ok: false;
      errorCode: "config" | "http" | "timeout" | "transport" | "empty";
      errorMessage: string;
      httpStatus?: number;
      latencyMs: number;
    };

export interface ElevenLabsStreamResult {
  ok: true;
  contentType: string;
  totalBytes: number;
  latencyMs: number;
}

export type ElevenLabsStreamCallResult =
  | ElevenLabsStreamResult
  | {
      ok: false;
      errorCode: "config" | "http" | "timeout" | "transport";
      errorMessage: string;
      httpStatus?: number;
      latencyMs: number;
    };

export interface ElevenLabsClientOptions {
  apiKey: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ElevenLabsClient {
  /**
   * Synthesize text into audio in a single request. Returns the
   * complete audio buffer. Use this for short utterances (greetings,
   * single sentences) where you can wait for the full buffer before
   * playback.
   */
  textToSpeech(input: ElevenLabsTtsInput): Promise<ElevenLabsCallResult>;

  /**
   * Streaming variant — pipes audio chunks to `onChunk` as they
   * arrive. Lower time-to-first-byte (~100-300ms). Use this on the
   * voice agent path so the patient hears the first words ASAP.
   */
  streamTextToSpeech(
    input: ElevenLabsTtsInput,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<ElevenLabsStreamCallResult>;

  /**
   * List the configured voices. Useful for an admin UI; not used
   * on the hot path.
   */
  listVoices(): Promise<ElevenLabsListVoicesResult>;
}

export interface ElevenLabsVoiceSummary {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
}

export type ElevenLabsListVoicesResult =
  | { ok: true; voices: ElevenLabsVoiceSummary[]; latencyMs: number }
  | {
      ok: false;
      errorCode: "config" | "http" | "timeout" | "transport" | "parse";
      errorMessage: string;
      httpStatus?: number;
      latencyMs: number;
    };

export function createElevenLabsClient(
  opts: ElevenLabsClientOptions,
): ElevenLabsClient {
  if (!opts.apiKey) {
    throw new Error(
      "createElevenLabsClient: apiKey is required (set ELEVENLABS_API_KEY).",
    );
  }
  const apiKey = opts.apiKey;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function ttsBody(input: ElevenLabsTtsInput): string {
    const body: Record<string, unknown> = {
      text: input.text,
      model_id: input.modelId ?? DEFAULT_ELEVENLABS_MODEL,
    };
    if (input.voiceSettings) body.voice_settings = input.voiceSettings;
    if (input.languageCode) body.language_code = input.languageCode;
    return JSON.stringify(body);
  }

  function ttsUrl(input: ElevenLabsTtsInput, streaming: boolean): string {
    const voice = input.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
    const suffix = streaming ? "/stream" : "";
    const params = new URLSearchParams();
    if (input.outputFormat) params.set("output_format", input.outputFormat);
    const qs = params.toString();
    return `${apiUrl}/text-to-speech/${voice}${suffix}${qs ? `?${qs}` : ""}`;
  }

  return {
    async textToSpeech(input): Promise<ElevenLabsCallResult> {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        input.timeoutMs ?? defaultTimeoutMs,
      );
      const startedAt = Date.now();
      try {
        const upstream = await fetchImpl(ttsUrl(input, false), {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/*",
          },
          body: ttsBody(input),
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `elevenlabs http ${upstream.status}: ${detail.slice(0, 200)}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const buf = new Uint8Array(await upstream.arrayBuffer());
        if (buf.byteLength === 0) {
          return {
            ok: false,
            errorCode: "empty",
            errorMessage: "elevenlabs returned empty audio buffer",
            latencyMs,
          };
        }
        return {
          ok: true,
          audio: buf,
          contentType: upstream.headers.get("content-type") ?? "audio/mpeg",
          latencyMs,
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

    async streamTextToSpeech(
      input,
      onChunk,
    ): Promise<ElevenLabsStreamCallResult> {
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        input.timeoutMs ?? defaultTimeoutMs,
      );
      const startedAt = Date.now();
      let totalBytes = 0;
      try {
        const upstream = await fetchImpl(ttsUrl(input, true), {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/*",
          },
          body: ttsBody(input),
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok || !upstream.body) {
          const detail = upstream.body
            ? await upstream.text().catch(() => "")
            : "";
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `elevenlabs stream http ${upstream.status}: ${detail.slice(0, 200)}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            totalBytes += value.byteLength;
            onChunk(value);
          }
        }
        return {
          ok: true,
          contentType: upstream.headers.get("content-type") ?? "audio/mpeg",
          totalBytes,
          latencyMs,
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

    async listVoices(): Promise<ElevenLabsListVoicesResult> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), defaultTimeoutMs);
      const startedAt = Date.now();
      try {
        const upstream = await fetchImpl(`${apiUrl}/voices`, {
          method: "GET",
          signal: ctrl.signal,
          headers: { "xi-api-key": apiKey, Accept: "application/json" },
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok) {
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `elevenlabs http ${upstream.status}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const json = (await upstream.json()) as {
          voices?: ElevenLabsVoiceSummary[];
        };
        return {
          ok: true,
          voices: Array.isArray(json.voices) ? json.voices : [],
          latencyMs,
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
  };
}
