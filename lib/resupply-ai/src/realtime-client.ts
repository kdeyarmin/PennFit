// @workspace/resupply-ai — OpenAI Realtime WebSocket client.
//
// Why hand-rolled (no `openai` SDK):
//   The OpenAI SDK's Realtime helpers add Node-stream plumbing we don't
//   want — we already have base64 µ-law audio frames coming from Twilio
//   and we want to forward them with a single `send()`. A direct `ws`
//   client keeps the surface area tiny, makes it trivial to mock in
//   tests, and removes one transitive dep this PHI-touching package
//   would otherwise own.
//
// What this file is responsible for:
//   - Opening the WS to `wss://api.openai.com/v1/realtime?model=...`
//     with the auth header and the `OpenAI-Beta: realtime=v1` toggle.
//   - Sending the initial `session.update` with our prompt + tools +
//     g711 µ-law I/O config.
//   - Demuxing the inbound JSON event stream into typed events:
//       audio.delta, transcript.delta (input + output), tool.call,
//       response.done, error, closed.
//   - Exposing the small set of outbound verbs the bridge needs:
//       appendAudio, commitInput, submitToolResult, requestResponse,
//       close.
//
// What this file is NOT responsible for:
//   - The patient/audit/db work — see ToolDispatcher in tools.ts.
//   - The Twilio side of the bridge — see media-stream.ts in
//     @workspace/resupply-telecom.
//
// Reconnection policy:
//   We do NOT auto-reconnect. The Realtime WS is bound to ONE call;
//   if the upstream drops, the call is dead and we bubble `closed` up
//   so the caller can hang up Twilio cleanly. Auto-reconnecting would
//   silently swallow the original failure and resurface as a "the
//   model forgot what was said" bug after the patient has already
//   given up and hung up.

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { OpenAiToolDescriptor, ToolName } from "./tools";

const REALTIME_URL_BASE = "wss://api.openai.com/v1/realtime";
export const DEFAULT_REALTIME_MODEL = "gpt-realtime";
// gpt-realtime-2 (GA, May 2026) — GPT-5-class reasoning over speech, 128K
// context, configurable reasoning effort. It requires OpenAI's *GA* nested
// session schema (`session.type:"realtime"`, `audio.input/output`), so it
// is opt-in behind `sessionSchema: "ga"` and validated on a preview before
// becoming a default. See docs/runbooks/realtime-ga-migration.md.
export const DEFAULT_REALTIME_GA_MODEL = "gpt-realtime-2";
// Input STT for the conversational session (drives turn-taking + the
// model's own transcript). Default is the proven beta model.
export const DEFAULT_REALTIME_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
// gpt-realtime-whisper — natively-streaming STT, the recommended GA
// transcription model. Lower WER on phone audio → fewer "say that again?"
// beats. Paired with the GA schema.
export const DEFAULT_REALTIME_GA_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
// `cedar` is the warmest of the current Realtime voices. In informal
// listening tests against `marin`, `alloy`, and `verse`, callers
// consistently rate cedar's prosody as the most "human" — slightly
// slower pace, more natural breath sounds, less broadcast-y. Swap by
// setting the `voice` option per call if a deployment prefers another.
export const DEFAULT_REALTIME_VOICE = "cedar";

/**
 * Inbound event shapes we care about. The wire schema is much wider —
 * we deliberately ignore unknown event types rather than fail-closed,
 * because OpenAI ships new event kinds out of band and we don't want
 * a server-side rollout to break our bridge.
 */
export interface RealtimeAudioDelta {
  /** Base64 µ-law @ 8kHz, framed exactly as we asked for. */
  audioBase64: string;
  /** OpenAI's id for the response this delta belongs to. */
  responseId: string;
}

export interface RealtimeTranscriptDelta {
  /** "input" = caller-side STT, "output" = agent's spoken reply. */
  source: "input" | "output";
  text: string;
  /** Whether this delta finalises the turn (the model emits a *.done event). */
  done: boolean;
  responseId?: string;
  itemId?: string;
}

export interface RealtimeToolCall {
  /** OpenAI's call_id — round-trip into the result. */
  callId: string;
  /** Function name selected by the model. */
  name: string;
  /** JSON-encoded arguments STRING from OpenAI. We do NOT eagerly parse here. */
  argumentsJson: string;
  responseId?: string;
}

export interface RealtimeError {
  /** Best-effort short error code for the audit log. */
  code: string;
  message: string;
}

export interface RealtimeClientEvents {
  open: () => void;
  "audio.delta": (delta: RealtimeAudioDelta) => void;
  "transcript.delta": (delta: RealtimeTranscriptDelta) => void;
  /**
   * The server's VAD detected the caller starting to speak. Used for
   * barge-in: when an external TTS engine (ElevenLabs) is producing the
   * agent's audio, the bridge must stop feeding/flush queued frames the
   * moment the caller interrupts. (In the built-in-audio path the
   * Realtime server handles barge-in itself via `interrupt_response`.)
   */
  "input.speech_started": () => void;
  "tool.call": (call: RealtimeToolCall) => void;
  "response.done": (info: { responseId: string }) => void;
  error: (err: RealtimeError) => void;
  closed: (info: { code: number; reason: string }) => void;
}

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /**
   * Whether the OpenAI Realtime model should generate the spoken audio
   * itself (its built-in `voice`, e.g. cedar). Default `true`.
   *
   * Set to `false` when an external TTS engine (ElevenLabs) owns the
   * voice: the session then runs in TEXT output mode, so the model
   * emits `response.output_text.*` events (which we surface as output
   * transcript turns) and NO `response.audio.delta`. The bridge
   * synthesizes those text turns through the external engine and
   * streams the resulting µ-law back to Twilio. Input audio + STT +
   * VAD turn-taking + tool calls are unaffected — only the output
   * modality changes.
   */
  generateAudio?: boolean;
  /**
   * Realtime session schema. `"beta"` (default) is the proven
   * `OpenAI-Beta: realtime=v1` flat session shape production runs on.
   * `"ga"` is OpenAI's GA nested `audio.input/output` shape required by
   * gpt-realtime-2. The GA path is feature-flagged and validated on a
   * preview before it becomes a default — see
   * docs/runbooks/realtime-ga-migration.md. The inbound event demux
   * already handles both schemas' event names, so only the outbound
   * session.update + connection header differ.
   */
  sessionSchema?: "beta" | "ga";
  /**
   * GA only — reasoning effort for gpt-realtime-2. `"low"` (default) keeps
   * a live phone agent snappy; higher values add latency + token spend.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /**
   * Input STT model for the conversational session. Defaults to
   * gpt-4o-mini-transcribe (beta); pass gpt-realtime-whisper on GA.
   */
  transcriptionModel?: string;
  /**
   * Wire audio-format token. Beta sends it as a bare string
   * (`g711_ulaw`); GA wraps it (`{ type: "audio/pcmu" }`). Exposed so the
   * exact GA µ-law token can be corrected during preview validation
   * without a code change (OpenAI's GA telephony token wasn't fully
   * documented at build time).
   */
  audioFormat?: string;
  /** System prompt, already built (see prompts.ts). */
  instructions: string;
  /** Tool descriptors (see tools.ts). */
  tools: readonly OpenAiToolDescriptor[];
  /**
   * Allowed tool name set — defensive guard so the descriptor list
   * cannot accidentally enable a tool we have no implementation for.
   * The bridge uses this same set when validating model tool calls.
   */
  allowedToolNames: ReadonlySet<ToolName>;
  /**
   * Optional WebSocket factory. Tests pass a fake; production callers
   * leave it undefined and we use real `ws`.
   */
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocketLike;
}

/**
 * Minimal subset of `ws.WebSocket` we depend on — narrowed so tests
 * don't have to implement the full thing.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | string) => void,
  ): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

const OPEN: number = 1;

// Standard typed-EventEmitter pattern (class + same-name interface).
// See VoiceBridge for the rationale on disabling no-unsafe-declaration-merging.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class RealtimeClient extends EventEmitter {
  private readonly opts: Required<
    Omit<
      RealtimeClientOptions,
      "webSocketFactory" | "voice" | "model" | "generateAudio"
    >
  > & {
    model: string;
    voice: string;
    generateAudio: boolean;
  };
  private readonly ws: WebSocketLike;
  private sessionUpdateSent = false;
  private closed = false;
  /**
   * Last time we emitted a `ws_backpressure` error. Throttles the
   * emission to once per second during a sustained stall so the
   * consumer's log dashboard isn't flooded with one warning per
   * dropped Twilio media frame (50 frames/sec).
   */
  private lastBackpressureWarnAt = 0;

  constructor(opts: RealtimeClientOptions) {
    super();
    if (!opts.apiKey) {
      throw new Error(
        "RealtimeClient: apiKey is required. Set OPENAI_API_KEY.",
      );
    }
    const sessionSchema = opts.sessionSchema ?? "beta";
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_REALTIME_MODEL,
      voice: opts.voice ?? DEFAULT_REALTIME_VOICE,
      generateAudio: opts.generateAudio ?? true,
      instructions: opts.instructions,
      tools: opts.tools,
      allowedToolNames: opts.allowedToolNames,
      sessionSchema,
      reasoningEffort: opts.reasoningEffort ?? "low",
      transcriptionModel:
        opts.transcriptionModel ?? DEFAULT_REALTIME_TRANSCRIBE_MODEL,
      // Beta sends a bare µ-law string; GA wraps the µ-law token in an
      // object. Default the token per schema; either can be overridden.
      audioFormat:
        opts.audioFormat ??
        (sessionSchema === "ga" ? "audio/pcmu" : "g711_ulaw"),
    };

    // Attach a noop "error" listener immediately so a synchronously
    // emitted error event (rare, but possible if the WS lib emits
    // one before the bridge can wire its own listeners) doesn't
    // hit the EventEmitter's default "unhandled error → throw"
    // behavior and crash the worker process. The bridge attaches
    // its real handler when it constructs around this client; it
    // becomes the second listener.
    this.on("error", () => {
      /* default no-op until consumer attaches a real handler */
    });

    const url = `${REALTIME_URL_BASE}?model=${encodeURIComponent(this.opts.model)}`;
    // The `realtime=v1` beta marker selects the flat beta session schema.
    // The GA schema (gpt-realtime-2) is reached WITHOUT it — sending the
    // beta header alongside a GA model is one of the things preview
    // validation confirms (see the realtime-ga runbook).
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (this.opts.sessionSchema !== "ga") {
      headers["OpenAI-Beta"] = "realtime=v1";
    }

    this.ws = opts.webSocketFactory
      ? opts.webSocketFactory(url, headers)
      : (new WebSocket(url, { headers }) as unknown as WebSocketLike);

    this.ws.on("open", () => {
      this.sendSessionUpdate();
      this.emit("open");
    });
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("error", (err) => {
      this.emit("error", { code: "ws_error", message: err.message });
    });
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      this.emit("closed", { code, reason: reason.toString("utf8") });
    });
  }

  // ---- Outbound API ------------------------------------------------------

  /** Forward base64-encoded µ-law audio captured from Twilio. */
  appendAudio(base64Mulaw: string): void {
    // Drop audio frames when the WS send buffer is already deep —
    // a stalled OpenAI socket (network blip, vendor throttle)
    // otherwise lets every 20ms Twilio frame queue up unbounded.
    // For a 15-minute call that's ~45,000 frames, plus the kernel
    // buffer behind it; concurrent calls compound and RSS balloons
    // toward OOM. 256 KB is well above one-frame-per-tick steady
    // state but well below where it begins to matter for delivery
    // latency. The hard drop is preferable to the OOM-kill that
    // would otherwise take down every concurrent call.
    const MAX_OUTBOUND_BUFFER_BYTES = 256 * 1024;
    const bufferedAmount = (this.ws as unknown as { bufferedAmount?: number })
      .bufferedAmount;
    if (
      typeof bufferedAmount === "number" &&
      bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES
    ) {
      // Throttle to at most one error emission per second during a
      // sustained stall. Twilio sends ~50 media frames/sec, so without
      // throttling a 5s stall would flood the consumer with 250 warns
      // that all carry the same actionable signal.
      const now = Date.now();
      if (now - this.lastBackpressureWarnAt > 1_000) {
        this.lastBackpressureWarnAt = now;
        this.emit("error", {
          code: "ws_backpressure",
          message: `OpenAI realtime WS send buffer at ${bufferedAmount} bytes — dropping audio frames`,
        });
      }
      return;
    }
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: base64Mulaw,
    });
  }

  /**
   * Tell OpenAI we've finished a chunk of input audio. With server VAD
   * (which we use), the server commits automatically — but we expose
   * this for test hooks and for the eventual push-to-talk fallback.
   */
  commitInput(): void {
    this.sendJson({ type: "input_audio_buffer.commit" });
  }

  /**
   * Reply to a prior `tool.call` event with a JSON-serialisable result.
   * The Realtime API expects the result as a STRING — we stringify
   * here so callers don't accidentally double-stringify.
   */
  submitToolResult(callId: string, output: unknown): void {
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      },
    });
    // After a function output we explicitly request a follow-up response
    // so the model speaks the next turn. Without this, server VAD
    // alone won't trigger a response since the patient hasn't spoken
    // since the tool call.
    this.requestResponse();
  }

  requestResponse(): void {
    this.sendJson({ type: "response.create" });
  }

  close(code = 1000, reason = "client_close"): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } finally {
      this.closed = true;
    }
  }

  // ---- Inbound demux -----------------------------------------------------

  private handleMessage(data: Buffer | ArrayBuffer | string): void {
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
      this.emit("error", {
        code: "invalid_json",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const type = typeof payload.type === "string" ? payload.type : "";
    switch (type) {
      case "response.audio.delta":
      case "response.output_audio.delta": {
        // Realtime API has shipped both names across versions. Treat
        // them as equivalent so a server-side rollout doesn't silence
        // the agent.
        const audio = typeof payload.delta === "string" ? payload.delta : null;
        const responseId =
          typeof payload.response_id === "string" ? payload.response_id : "";
        if (!audio) return;
        this.emit("audio.delta", { audioBase64: audio, responseId });
        return;
      }
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (!text) return;
        this.emit("transcript.delta", {
          source: "output",
          text,
          done: false,
          responseId:
            typeof payload.response_id === "string"
              ? payload.response_id
              : undefined,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text =
          typeof payload.transcript === "string" ? payload.transcript : "";
        this.emit("transcript.delta", {
          source: "output",
          text,
          done: true,
          responseId:
            typeof payload.response_id === "string"
              ? payload.response_id
              : undefined,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      // Text-output mode (generateAudio:false, used when an external TTS
      // engine owns the voice). The model emits text deltas/done instead
      // of audio + audio_transcript. We map them onto the SAME output
      // transcript events so the bridge's turn-coalescing + (for the
      // ElevenLabs path) synthesis trigger work identically. Both the
      // older (`response.text.*`) and GA (`response.output_text.*`)
      // names are accepted so an OpenAI rollout can't silence the agent.
      case "response.text.delta":
      case "response.output_text.delta": {
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (!text) return;
        this.emit("transcript.delta", {
          source: "output",
          text,
          done: false,
          responseId:
            typeof payload.response_id === "string"
              ? payload.response_id
              : undefined,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "response.text.done":
      case "response.output_text.done": {
        const text = typeof payload.text === "string" ? payload.text : "";
        this.emit("transcript.delta", {
          source: "output",
          text,
          done: true,
          responseId:
            typeof payload.response_id === "string"
              ? payload.response_id
              : undefined,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "input_audio_buffer.speech_started": {
        // Caller started talking — surface for barge-in handling.
        this.emit("input.speech_started");
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (!text) return;
        this.emit("transcript.delta", {
          source: "input",
          text,
          done: false,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text =
          typeof payload.transcript === "string" ? payload.transcript : "";
        this.emit("transcript.delta", {
          source: "input",
          text,
          done: true,
          itemId:
            typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "response.function_call_arguments.done": {
        // Final, complete arguments string + call_id. The streaming
        // `*.delta` siblings of this event are useful for UI but the
        // bridge only needs the final shot.
        const callId =
          typeof payload.call_id === "string" ? payload.call_id : "";
        const name = typeof payload.name === "string" ? payload.name : "";
        const argsJson =
          typeof payload.arguments === "string" ? payload.arguments : "{}";
        if (!callId || !name) return;
        this.emit("tool.call", {
          callId,
          name,
          argumentsJson: argsJson,
          responseId:
            typeof payload.response_id === "string"
              ? payload.response_id
              : undefined,
        });
        return;
      }
      case "response.done": {
        const responseId =
          typeof (payload.response as { id?: unknown } | undefined)?.id ===
          "string"
            ? (payload.response as { id: string }).id
            : "";
        this.emit("response.done", { responseId });
        return;
      }
      case "error": {
        const errBody = (payload.error ?? {}) as Record<string, unknown>;
        this.emit("error", {
          code:
            typeof errBody.code === "string" ? errBody.code : "openai_error",
          message:
            typeof errBody.message === "string"
              ? errBody.message
              : "OpenAI Realtime returned an unstructured error",
        });
        return;
      }
      default:
        // Unknown / uninteresting event — ignore deliberately.
        return;
    }
  }

  private sendSessionUpdate(): void {
    if (this.sessionUpdateSent) return;
    const session =
      this.opts.sessionSchema === "ga"
        ? this.buildGaSession()
        : this.buildBetaSession();
    this.sendJson({ type: "session.update", session });
    this.sessionUpdateSent = true;
  }

  /** Tools, filtered against `allowedToolNames`. Shared by both schemas. */
  private enabledTools(): readonly OpenAiToolDescriptor[] {
    // A stray descriptor cannot enable a tool the dispatcher doesn't
    // implement, so we filter even though the bridge also validates.
    return this.opts.tools.filter((t) =>
      this.opts.allowedToolNames.has(t.name),
    );
  }

  /**
   * Semantic VAD waits for a semantic end-of-thought rather than a fixed
   * silence threshold, so the agent doesn't interrupt callers who pause
   * mid-sentence to think (very common with elderly speakers).
   * `eagerness: "low"` further pads the wait. This is the single biggest
   * "feels human, not robot" tuning lever on the Realtime API. Identical
   * shape in both schemas — only its placement differs.
   */
  private turnDetection(): Record<string, unknown> {
    return {
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    };
  }

  /** The proven `OpenAI-Beta: realtime=v1` flat session (production). */
  private buildBetaSession(): Record<string, unknown> {
    // Output modality: built-in audio (cedar) by default, or text-only
    // when an external TTS engine owns the voice. Input audio + STT + VAD
    // are identical in both cases — only the output side changes.
    const session: Record<string, unknown> = {
      modalities: this.opts.generateAudio ? ["audio", "text"] : ["text"],
      instructions: this.opts.instructions,
      // µ-law @ 8kHz inbound — same as Twilio's Media Streams default —
      // so we do zero transcoding of the caller audio.
      input_audio_format: this.opts.audioFormat,
      input_audio_transcription: { model: this.opts.transcriptionModel },
    };
    if (this.opts.generateAudio) {
      session.voice = this.opts.voice;
      session.output_audio_format = this.opts.audioFormat;
    }
    return {
      ...session,
      turn_detection: this.turnDetection(),
      // A small temperature bump lets the model vary phrasing turn-to-turn
      // so repeat callers don't hear the exact same sentence each time.
      temperature: 0.8,
      // Cap response length so the agent doesn't drift into monologues.
      max_response_output_tokens: 200,
      tools: this.enabledTools(),
      tool_choice: "auto",
    };
  }

  /**
   * OpenAI's GA nested session shape for gpt-realtime-2. The µ-law token,
   * transcription model, and reasoning effort are all driven by options so
   * the exact wire values can be corrected during preview validation
   * without a code change. The bridge's Twilio µ-law wiring is unchanged —
   * only the session schema differs.
   */
  private buildGaSession(): Record<string, unknown> {
    const audioFormat = { type: this.opts.audioFormat };
    const audio: Record<string, unknown> = {
      input: {
        format: audioFormat,
        turn_detection: this.turnDetection(),
        transcription: { model: this.opts.transcriptionModel },
      },
    };
    if (this.opts.generateAudio) {
      audio.output = { format: audioFormat, voice: this.opts.voice };
    }
    return {
      type: "realtime",
      model: this.opts.model,
      instructions: this.opts.instructions,
      output_modalities: this.opts.generateAudio ? ["audio"] : ["text"],
      audio,
      // gpt-realtime-2 is a reasoning model: depth is governed by `effort`,
      // not `temperature` (temperature is not accepted). "low" keeps a live
      // phone agent snappy.
      reasoning: { effort: this.opts.reasoningEffort },
      max_output_tokens: 200,
      tools: this.enabledTools(),
      tool_choice: "auto",
    };
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}

// EventEmitter typing — give callers strict listener signatures.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export interface RealtimeClient {
  on<E extends keyof RealtimeClientEvents>(
    event: E,
    listener: RealtimeClientEvents[E],
  ): this;
  off<E extends keyof RealtimeClientEvents>(
    event: E,
    listener: RealtimeClientEvents[E],
  ): this;
  emit<E extends keyof RealtimeClientEvents>(
    event: E,
    ...args: Parameters<RealtimeClientEvents[E]>
  ): boolean;
}
