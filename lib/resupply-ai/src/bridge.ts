// @workspace/resupply-ai — orchestration glue between the model, the
// tool dispatcher, and the audio sink.
//
// What this file is:
//   A pure function (well — a pure constructor) that wires together
//   three collaborators:
//     1. `RealtimeClient` — the OpenAI Realtime WS.
//     2. `ToolDispatcher` — implemented in the API; runs side effects.
//     3. `MediaStreamSink` — the Twilio-facing WS, treated here as an
//        opaque writer of base64 µ-law frames so the AI lib doesn't
//        depend on `@workspace/resupply-telecom` (Rule 9).
//
// Why a dedicated `bridge.ts` and not just call-sites in the API:
//   - Lets us unit-test the orchestration logic with three fakes,
//     without spinning up Express, ws, or pg.
//   - Centralises the transcript-coalescing rules (we DON'T persist
//     every `*.delta`; we persist on `done`) and the tool-call audit
//     emission so they stay consistent if/when we add a second
//     transport later.
//
// Lifecycle events emitted (TypedEventEmitter-style):
//   - `session.opened`            — Realtime session ready to talk.
//   - `transcript.turn`           — one finalised turn (input or output).
//   - `tool.invoked`              — a tool finished (success OR failure).
//   - `session.error`             — an upstream error worth audit-logging.
//   - `session.closed`            — both sides should hang up.

import { EventEmitter } from "node:events";

import type { RealtimeClient } from "./realtime-client";
import {
  TOOL_ARG_SCHEMAS,
  TOOL_NAMES,
  type ToolDispatcher,
  type ToolName,
  type ToolResultByName,
  summarizeToolArgsForAudit,
} from "./tools";

/**
 * The Twilio-facing audio sink. The bridge writes base64 µ-law frames
 * to it; it is up to the implementation to wrap those into the
 * `media` envelope Twilio's Media Streams protocol expects.
 *
 * This interface is deliberately tiny so the AI lib can declare it
 * without importing the telecom lib.
 */
export interface MediaStreamSink {
  /** Forward a base64 µ-law frame back to the caller. */
  writeAudioBase64(base64Mulaw: string): void;
  /**
   * Optional — if the model produces a new response (barge-in), the
   * bridge calls this to drop any audio Twilio has queued for the
   * previous response. Implementations may no-op.
   */
  clearQueuedAudio?(): void;
}

export interface TranscriptTurn {
  source: "input" | "output";
  text: string;
  itemId?: string;
}

export interface ToolInvocation {
  name: ToolName;
  callId: string;
  /** Sanitised arg shape for audit (no PHI). */
  auditArgs: Record<string, unknown>;
  status: "ok" | "validation_error" | "dispatch_error" | "unknown_tool";
  /** Present when status === 'ok'. */
  result?: ToolResultByName[ToolName];
  /** Present otherwise. */
  errorMessage?: string;
}

export interface SessionError {
  source: "openai" | "tool" | "tts";
  code: string;
  message: string;
}

/**
 * External text-to-speech engine (e.g. ElevenLabs). When provided to
 * the bridge, the agent's voice is produced by THIS engine instead of
 * the OpenAI Realtime model's built-in voice: the Realtime session runs
 * in text-output mode, and for each finalised output turn the bridge
 * calls `synthesize`, forwarding the resulting base64 µ-law frames to
 * the audio sink.
 *
 * Contract:
 *   - Emit base64-encoded µ-law @ 8kHz frames via `onFrame` (the same
 *     format the sink forwards to Twilio).
 *   - Respect `signal`: on abort (caller barge-in) stop synthesising and
 *     resolve/reject promptly. Frames emitted after abort are ignored by
 *     the bridge.
 *   - Resolve when the utterance is fully synthesised; reject on a
 *     vendor/transport error (the bridge logs it as a `tts` session
 *     error and continues — a failed utterance drops its audio but does
 *     NOT end the call).
 */
export interface TtsSynthesizer {
  synthesize(
    text: string,
    onFrame: (base64Mulaw: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface BridgeEvents {
  "session.opened": () => void;
  "transcript.turn": (turn: TranscriptTurn) => void;
  "tool.invoked": (invocation: ToolInvocation) => void;
  "session.error": (err: SessionError) => void;
  "session.closed": (info: { code: number; reason: string }) => void;
}

export interface BridgeOptions {
  client: RealtimeClient;
  sink: MediaStreamSink;
  dispatcher: ToolDispatcher;
  /**
   * Optional external TTS engine. When set, the bridge produces the
   * agent's voice by synthesising each finalised OUTPUT transcript turn
   * through this engine (and ignores any built-in `audio.delta` from
   * the model — the Realtime client should be constructed with
   * `generateAudio: false` so none are emitted). When unset, the bridge
   * forwards the model's built-in audio deltas straight to the sink
   * (the default cedar path).
   */
  tts?: TtsSynthesizer;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>(TOOL_NAMES);

function isKnownTool(name: string): name is ToolName {
  return KNOWN_TOOL_NAMES.has(name as ToolName);
}

// `VoiceBridge` uses the standard typed-EventEmitter pattern: a class
// merged with an interface of the same name that pins typed `on`/`off`/
// `emit` overloads. ESLint's `no-unsafe-declaration-merging` flags this
// pattern by default; we accept it because the alternatives (typed-
// emitter package, hand-rolled wrapper) add a dep or boilerplate
// without a real safety win.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class VoiceBridge extends EventEmitter {
  private readonly client: RealtimeClient;
  private readonly sink: MediaStreamSink;
  private readonly dispatcher: ToolDispatcher;
  private readonly tts: TtsSynthesizer | null;

  // Buffer for input STT deltas — coalesce until `done` fires so each
  // patient turn becomes ONE messages-table row, not N. Keyed on
  // `itemId` so interleaved items don't bleed into each other.
  private readonly inputBuf = new Map<string, string>();
  private readonly outputBuf = new Map<string, string>();

  // External-TTS synthesis queue (only used when `this.tts` is set).
  // Utterances are synthesised one at a time so their µ-law frames reach
  // the sink in order; `ttsAbort` cancels the in-flight synthesis on a
  // caller barge-in.
  private readonly ttsQueue: string[] = [];
  private ttsDraining = false;
  private ttsAbort: AbortController | null = null;

  constructor(opts: BridgeOptions) {
    super();
    this.client = opts.client;
    this.sink = opts.sink;
    this.dispatcher = opts.dispatcher;
    this.tts = opts.tts ?? null;
    this.wireRealtimeEvents();
  }

  /** Call when the upstream Twilio Media Stream delivers audio. */
  forwardCallerAudio(base64Mulaw: string): void {
    this.client.appendAudio(base64Mulaw);
  }

  /** Stop both sides cleanly. Idempotent. */
  close(reason: string): void {
    // Abort any in-flight external-TTS synthesis and drop the queue so a
    // synthesiser promise can't keep writing to a sink whose socket is
    // closing.
    this.ttsQueue.length = 0;
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    this.client.close(1000, reason);
  }

  private wireRealtimeEvents(): void {
    this.client.on("open", () => {
      this.emit("session.opened");
    });

    this.client.on("audio.delta", (delta) => {
      // When an external TTS engine owns the voice we generate the audio
      // ourselves from the output transcript; ignore any built-in audio
      // the model emits (there should be none — it's in text mode — but
      // this is belt-and-suspenders against a modality config drift).
      if (this.tts) return;
      this.sink.writeAudioBase64(delta.audioBase64);
    });

    // Caller barge-in. The built-in-audio path relies on the Realtime
    // server's own `interrupt_response`; but when WE own playback via an
    // external TTS engine, we must stop feeding + flush queued frames
    // ourselves the instant the caller starts speaking.
    this.client.on("input.speech_started", () => {
      if (!this.tts) return;
      this.bargeInTts();
    });

    this.client.on("transcript.delta", (delta) => {
      const buf = delta.source === "input" ? this.inputBuf : this.outputBuf;
      const key = delta.itemId ?? `__${delta.source}__`;
      const prior = buf.get(key) ?? "";
      const next = delta.done ? delta.text || prior : prior + delta.text;
      if (delta.done) {
        buf.delete(key);
        const text = next.trim();
        if (text.length > 0) {
          this.emit("transcript.turn", {
            source: delta.source,
            text,
            itemId: delta.itemId,
          });
          // External-TTS path: synthesise the agent's finalised spoken
          // turn. Input turns (the caller) are never synthesised.
          if (this.tts && delta.source === "output") {
            this.enqueueTts(text);
          }
        }
      } else {
        buf.set(key, next);
      }
    });

    this.client.on("tool.call", (call) => {
      this.handleToolCall(call.callId, call.name, call.argumentsJson).catch(
        (err) => {
          // Outer try-catch in handleToolCall covers the dispatch path.
          // This catches any unexpected throw from the pre-dispatch validation
          // path (e.g. summarizeToolArgsForAudit), preventing an unhandled
          // rejection that would crash the process in Node ≥ 15.
          this.emit("session.error", {
            source: "tool",
            code: "handle_tool_call_error",
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
    });

    this.client.on("error", (err) => {
      this.emit("session.error", {
        source: "openai",
        code: err.code,
        message: err.message,
      });
    });

    this.client.on("closed", (info) => {
      this.emit("session.closed", info);
    });
  }

  private async handleToolCall(
    callId: string,
    name: string,
    argsJson: string,
  ): Promise<void> {
    if (!isKnownTool(name)) {
      const summary = { name, reason: "unknown" };
      this.emit("tool.invoked", {
        name: name as ToolName,
        callId,
        auditArgs: summary,
        status: "unknown_tool",
        errorMessage: `Unknown tool name: ${name}`,
      });
      this.client.submitToolResult(callId, {
        ok: false,
        error: "unknown_tool",
        message: `Tool ${name} is not implemented.`,
      });
      return;
    }

    let argsObj: unknown;
    try {
      argsObj = JSON.parse(argsJson);
    } catch (err) {
      const auditArgs = summarizeToolArgsForAudit(name, {});
      this.emit("tool.invoked", {
        name,
        callId,
        auditArgs,
        status: "validation_error",
        errorMessage: `arguments_not_json: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.client.submitToolResult(callId, {
        ok: false,
        error: "arguments_not_json",
        message: "Arguments JSON failed to parse — please try the call again.",
      });
      return;
    }

    const auditArgs = summarizeToolArgsForAudit(name, argsObj);
    const parsed = TOOL_ARG_SCHEMAS[name].safeParse(argsObj);
    if (!parsed.success) {
      this.emit("tool.invoked", {
        name,
        callId,
        auditArgs,
        status: "validation_error",
        errorMessage: parsed.error.issues.map((i) => i.message).join("; "),
      });
      this.client.submitToolResult(callId, {
        ok: false,
        error: "invalid_arguments",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
      return;
    }

    try {
      const result = await this.dispatcher.dispatch({
        callId,
        name,
        // Cast: zod's parsed type matches ToolArgsByName[name], but TS
        // can't see through the dynamic key. Safety is enforced at
        // runtime by the schema lookup above.
        args: parsed.data as never,
      });
      this.emit("tool.invoked", {
        name,
        callId,
        auditArgs,
        status: "ok",
        result: result.result,
      });
      this.client.submitToolResult(callId, result.result);

      // `end_call` is the canonical hangup signal — the model has
      // committed to terminating. Close upstream so the API can tear
      // down the Twilio leg.
      if (name === "end_call") {
        this.client.close(1000, "end_call_tool_invoked");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("tool.invoked", {
        name,
        callId,
        auditArgs,
        status: "dispatch_error",
        errorMessage: message,
      });
      this.client.submitToolResult(callId, {
        ok: false,
        error: "dispatch_failed",
        message:
          "I couldn't complete that just now. Please try again or ask for a person.",
      });
      this.emit("session.error", {
        source: "tool",
        code: "dispatch_error",
        message,
      });
    }
  }

  // ---- External TTS (ElevenLabs) --------------------------------------

  /** Queue an agent utterance for synthesis and kick the drain loop. */
  private enqueueTts(text: string): void {
    this.ttsQueue.push(text);
    void this.drainTts();
  }

  /**
   * Synthesise queued utterances one at a time so their µ-law frames
   * reach the sink in order. Re-entrancy guarded by `ttsDraining`; a new
   * utterance enqueued mid-drain is picked up by the running loop.
   */
  private async drainTts(): Promise<void> {
    if (this.ttsDraining || !this.tts) return;
    this.ttsDraining = true;
    try {
      while (this.ttsQueue.length > 0) {
        const text = this.ttsQueue.shift();
        if (text === undefined) break;
        const ctrl = new AbortController();
        this.ttsAbort = ctrl;
        try {
          await this.tts.synthesize(
            text,
            (frame) => {
              // A barge-in (or call close) may have fired mid-synthesis;
              // drop late frames rather than talk over the caller.
              if (ctrl.signal.aborted) return;
              this.sink.writeAudioBase64(frame);
            },
            ctrl.signal,
          );
        } catch (err) {
          // A failed utterance loses its audio but must NOT end the call.
          // The transcript turn was already emitted/persisted upstream.
          if (!ctrl.signal.aborted) {
            this.emit("session.error", {
              source: "tts",
              code: "tts_synthesis_failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          if (this.ttsAbort === ctrl) this.ttsAbort = null;
        }
      }
    } finally {
      this.ttsDraining = false;
    }
  }

  /**
   * Caller interrupted: drop everything queued, abort the in-flight
   * synthesis, and flush whatever the sink has already buffered toward
   * Twilio so the agent goes quiet immediately.
   */
  private bargeInTts(): void {
    this.ttsQueue.length = 0;
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    this.sink.clearQueuedAudio?.();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export interface VoiceBridge {
  on<E extends keyof BridgeEvents>(event: E, listener: BridgeEvents[E]): this;
  off<E extends keyof BridgeEvents>(event: E, listener: BridgeEvents[E]): this;
  emit<E extends keyof BridgeEvents>(
    event: E,
    ...args: Parameters<BridgeEvents[E]>
  ): boolean;
}
