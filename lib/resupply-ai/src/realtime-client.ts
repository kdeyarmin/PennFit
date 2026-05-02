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
export const DEFAULT_REALTIME_VOICE = "marin";

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
  "tool.call": (call: RealtimeToolCall) => void;
  "response.done": (info: { responseId: string }) => void;
  error: (err: RealtimeError) => void;
  closed: (info: { code: number; reason: string }) => void;
}

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  voice?: string;
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
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
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
  on(event: "message", listener: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

const OPEN: number = 1;

// Standard typed-EventEmitter pattern (class + same-name interface).
// See VoiceBridge for the rationale on disabling no-unsafe-declaration-merging.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class RealtimeClient extends EventEmitter {
  private readonly opts: Required<
    Omit<RealtimeClientOptions, "webSocketFactory" | "voice" | "model">
  > & {
    model: string;
    voice: string;
  };
  private readonly ws: WebSocketLike;
  private sessionUpdateSent = false;
  private closed = false;

  constructor(opts: RealtimeClientOptions) {
    super();
    if (!opts.apiKey) {
      throw new Error(
        "RealtimeClient: apiKey is required. Set OPENAI_API_KEY.",
      );
    }
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_REALTIME_MODEL,
      voice: opts.voice ?? DEFAULT_REALTIME_VOICE,
      instructions: opts.instructions,
      tools: opts.tools,
      allowedToolNames: opts.allowedToolNames,
    };

    const url = `${REALTIME_URL_BASE}?model=${encodeURIComponent(this.opts.model)}`;
    const headers = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    };

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
            typeof payload.response_id === "string" ? payload.response_id : undefined,
          itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
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
            typeof payload.response_id === "string" ? payload.response_id : undefined,
          itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (!text) return;
        this.emit("transcript.delta", {
          source: "input",
          text,
          done: false,
          itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
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
          itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
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
            typeof payload.response_id === "string" ? payload.response_id : undefined,
        });
        return;
      }
      case "response.done": {
        const responseId =
          typeof (payload.response as { id?: unknown } | undefined)?.id ===
          "string"
            ? ((payload.response as { id: string }).id)
            : "";
        this.emit("response.done", { responseId });
        return;
      }
      case "error": {
        const errBody = (payload.error ?? {}) as Record<string, unknown>;
        this.emit("error", {
          code: typeof errBody.code === "string" ? errBody.code : "openai_error",
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
    // Filter the descriptor list against `allowedToolNames` so a stray
    // descriptor cannot enable a tool the dispatcher doesn't implement.
    const tools = this.opts.tools.filter((t) =>
      this.opts.allowedToolNames.has(t.name),
    );
    this.sendJson({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: this.opts.voice,
        instructions: this.opts.instructions,
        // µ-law @ 8kHz on both ends — same as Twilio's Media Streams
        // default — so we do zero transcoding in the bridge.
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad" },
        tools,
        tool_choice: "auto",
      },
    });
    this.sessionUpdateSent = true;
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
