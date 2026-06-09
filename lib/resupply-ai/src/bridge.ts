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

/**
 * A single streaming-synthesis session for ONE agent turn (e.g. the
 * ElevenLabs stream-input WebSocket). Unlike {@link TtsSynthesizer}, which
 * is handed a complete utterance, a session is fed text INCREMENTALLY as
 * the model generates it and streams audio back over the whole turn — so a
 * multi-sentence turn rides one connection with prosody carried across
 * sentence boundaries, and the caller hears the first words while the model
 * is still producing the rest.
 *
 * Contract:
 *   - `onFrame` emits base64 µ-law @ 8kHz frames (the sink's format).
 *   - `onError` is a vendor/transport failure — the bridge logs it as a
 *     `tts` session error and drops that turn's audio; it does NOT end the
 *     call.
 *   - `onDone` fires once when the session has fully finished (all audio
 *     delivered); the bridge uses it to release the session reference.
 *   - The returned session ignores `pushText`/`flush`/`end` after `abort`,
 *     and emits no frames once aborted (barge-in must go silent at once).
 */
export interface TtsStreamHandlers {
  onFrame: (base64Mulaw: string) => void;
  onError: (err: Error) => void;
  onDone?: () => void;
}

export interface TtsStreamSession {
  /** Append a chunk of the turn's text as the model streams it. */
  pushText(text: string): void;
  /** Nudge the engine to synthesise buffered text now (latency). */
  flush(): void;
  /** Signal no-more-text; the engine finishes the turn, then completes. */
  end(): void;
  /** Tear down immediately (barge-in / call close); go silent at once. */
  abort(): void;
}

export interface TtsStreamer {
  /** Open a streaming session for one agent turn. */
  openSession(handlers: TtsStreamHandlers): TtsStreamSession;
}

export interface BridgeEvents {
  "session.opened": () => void;
  "transcript.turn": (turn: TranscriptTurn) => void;
  "tool.invoked": (invocation: ToolInvocation) => void;
  "session.error": (err: SessionError) => void;
  "session.closed": (info: { code: number; reason: string }) => void;
}

/**
 * Configuration for the tool-call dead-air filler. When a tool call is
 * dispatched the agent goes silent for the round-trip (DB lookup + the
 * model generating its next turn + TTS first-byte) — easily 1–2s of dead
 * air, the single most robotic moment of a call. When this is configured
 * (and an external TTS engine owns the voice), the bridge speaks one short
 * filler ("one moment…") if the gap runs long and the agent hasn't just
 * spoken. See {@link VoiceBridge} for the exact guard conditions.
 */
export interface ToolCallFillerConfig {
  /**
   * Short, natural acknowledgements to choose from. Rotated so the caller
   * never hears the same one twice in a row. Keep them brief — a filler
   * that runs longer than the gap it covers defeats the purpose.
   */
  phrases: readonly string[];
  /**
   * How long the tool call must stay in flight before a filler is spoken.
   * Fast lookups resolve before this fires, so they get no filler (there
   * was no dead air to cover). Default 600ms.
   */
  delayMs?: number;
  /**
   * If the agent finished speaking within this window before the filler
   * would fire, skip it — the model almost certainly already said "let me
   * check", and a second filler on top would sound stilted. Default
   * 1500ms.
   */
  graceMs?: number;
}

/**
 * Default filler phrases for the tool-call dead-air bridge. Short, warm,
 * and varied so a multi-lookup call doesn't repeat one. Exported so the
 * API can pass them (or its own list) when wiring the bridge.
 */
export const DEFAULT_TOOL_CALL_FILLER_PHRASES: readonly string[] = [
  "One moment.",
  "Let me take a look.",
  "Just a sec.",
  "Okay, let me check on that.",
  "Bear with me one second.",
];

const DEFAULT_FILLER_DELAY_MS = 600;
const DEFAULT_FILLER_GRACE_MS = 1500;
// Synthetic output-item key the streaming-TTS path uses for a filler turn.
// Distinct from any real model item id (and the "__output__" fallback) so
// the next genuine turn always transitions off it cleanly.
const FILLER_STREAM_ITEM_KEY = "__tool_call_filler__";

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
  /**
   * Optional streaming external TTS engine (ElevenLabs stream-input WS).
   * Takes precedence over `tts` when both are set. Instead of synthesising
   * each finished sentence as its own request, the bridge opens ONE
   * session per agent turn and feeds the model's output text into it as it
   * streams — lowest latency and best cross-sentence prosody. Like `tts`,
   * it requires the Realtime client to run with `generateAudio: false`.
   */
  ttsStreamer?: TtsStreamer;
  /**
   * Optional tool-call dead-air filler. Only takes effect on the external-
   * TTS path (the bridge can't synthesise a filler on the built-in cedar
   * path — the model owns that audio). Omit to disable entirely.
   */
  filler?: ToolCallFillerConfig;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>(TOOL_NAMES);

function isKnownTool(name: string): name is ToolName {
  return KNOWN_TOOL_NAMES.has(name as ToolName);
}

// Sentence-boundary detector for streaming the agent's voice on the
// external-TTS path. Returns the exclusive end index up to which `text` is
// one or more COMPLETE sentences — a run of terminal punctuation
// (. ! ? …) plus any trailing closing quote/bracket, then whitespace.
// Requiring the trailing whitespace avoids splitting a decimal ("12.5") or
// a terminator that's still mid-stream. It does NOT special-case
// abbreviations ("Dr. ", "e.g. ") — those split into an extra chunk, which
// is harmless: one more TTS request, identical audio. Returns 0 when
// there's no safe split point yet.
const SENTENCE_BOUNDARY_RE = /[.!?…]+["')\]]*\s/g;
function lastSpeakableBoundary(text: string): number {
  let end = 0;
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  for (
    let m = SENTENCE_BOUNDARY_RE.exec(text);
    m !== null;
    m = SENTENCE_BOUNDARY_RE.exec(text)
  ) {
    end = m.index + m[0].length;
  }
  return end;
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
  private readonly ttsStreamer: TtsStreamer | null;

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

  // Per-output-item count of characters already handed to the external
  // TTS engine as complete sentences, so the finalising `done` only
  // synthesises the un-spoken tail (no sentence is voiced twice). Keyed by
  // itemId like the transcript buffers above.
  private readonly ttsFlushed = new Map<string, number>();

  // Streaming-TTS session state (only used when `this.ttsStreamer` is set).
  // One session spans one agent turn; `ttsStreamItemId` pins it to the
  // output item it's voicing and `ttsStreamPushed` tracks how many chars
  // of that turn we've already fed in (so we push only the new delta).
  private ttsStream: TtsStreamSession | null = null;
  private ttsStreamItemId: string | null = null;
  private ttsStreamPushed = 0;

  // Tool-call dead-air filler state (only used when `this.filler` is set
  // AND an external TTS engine owns the voice). `fillerTimer` is the
  // pending "speak a filler if the gap runs long" timer; `lastOutputAt`
  // tracks when the agent last produced output text so we can skip the
  // filler when the model just acknowledged the caller itself; and
  // `lastFillerIndex` rotates the phrase list so no two fillers repeat
  // back to back.
  private readonly filler: Required<ToolCallFillerConfig> | null;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOutputAt = 0;
  private lastFillerIndex = -1;

  constructor(opts: BridgeOptions) {
    super();
    this.client = opts.client;
    this.sink = opts.sink;
    this.dispatcher = opts.dispatcher;
    this.tts = opts.tts ?? null;
    this.ttsStreamer = opts.ttsStreamer ?? null;
    this.filler =
      opts.filler && opts.filler.phrases.length > 0
        ? {
            phrases: opts.filler.phrases,
            delayMs: opts.filler.delayMs ?? DEFAULT_FILLER_DELAY_MS,
            graceMs: opts.filler.graceMs ?? DEFAULT_FILLER_GRACE_MS,
          }
        : null;
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
    this.ttsFlushed.clear();
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    // Tear down any open streaming-TTS session for the same reason.
    if (this.ttsStream) {
      this.ttsStream.abort();
      this.resetTtsStream();
    }
    this.cancelFiller();
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
      if (this.tts || this.ttsStreamer) return;
      this.sink.writeAudioBase64(delta.audioBase64);
    });

    // Caller barge-in. The built-in-audio path relies on the Realtime
    // server's own `interrupt_response`; but when WE own playback via an
    // external TTS engine, we must stop feeding + flush queued frames
    // ourselves the instant the caller starts speaking.
    this.client.on("input.speech_started", () => {
      // The caller is talking — never interject a filler over them, and
      // drop any pending one.
      this.cancelFiller();
      if (this.ttsStreamer) this.bargeInStream();
      else if (this.tts) this.bargeInTts();
    });

    this.client.on("transcript.delta", (delta) => {
      const isOutput = delta.source === "output";
      if (isOutput) {
        // The agent is producing its turn — note the time (so a filler
        // scheduled by an upcoming tool call can tell the model just
        // spoke) and cancel any filler still waiting to fire, since the
        // real reply is now landing.
        this.lastOutputAt = Date.now();
        this.cancelFiller();
      }
      const buf = delta.source === "input" ? this.inputBuf : this.outputBuf;
      const key = delta.itemId ?? `__${delta.source}__`;
      const prior = buf.get(key) ?? "";
      const next = delta.done ? delta.text || prior : prior + delta.text;

      // Drive whichever external-voice path is configured as the agent's
      // text streams. The streaming path (ElevenLabs WS) feeds text into an
      // open per-turn session; the per-utterance path (ElevenLabs HTTP)
      // voices each complete sentence as it lands. The built-in cedar path
      // does neither — it forwards `audio.delta` straight to the sink.
      if (isOutput && this.ttsStreamer) {
        this.driveTtsStream(key, next, delta.done);
      } else if (isOutput && this.tts && !delta.done) {
        this.flushSpeakableSentences(key, next);
      }

      if (!delta.done) {
        buf.set(key, next);
        return;
      }

      // Turn finalised.
      buf.delete(key);
      const flushedLen = this.ttsFlushed.get(key) ?? 0;
      this.ttsFlushed.delete(key);
      const text = next.trim();
      if (text.length > 0) {
        this.emit("transcript.turn", {
          source: delta.source,
          text,
          itemId: delta.itemId,
        });
      }
      // Per-utterance path only: synthesise the tail we did NOT already
      // stream as complete sentences, so an early-flushed sentence is never
      // re-spoken. `next` is the authoritative full turn text; the already-
      // voiced prefix is exactly its first `flushedLen` characters. (The
      // streaming path ended its session inside driveTtsStream.)
      if (isOutput && this.tts && !this.ttsStreamer) {
        const remainder = next.slice(flushedLen).trim();
        if (remainder.length > 0) this.enqueueTts(remainder);
      }
    });

    this.client.on("tool.call", (call) => {
      // Cover the dead air while the tool runs + the model composes its
      // reply. No-op unless a filler is configured on an external-TTS path.
      this.scheduleFiller(call.name);
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
      this.cancelFiller();
      this.emit("session.closed", info);
    });
  }

  // ---- Tool-call dead-air filler -------------------------------------

  /**
   * Arm the dead-air filler for an in-flight tool call. Restarts the timer
   * on each tool call (back-to-back lookups share one gap). No-ops unless a
   * filler is configured AND an external TTS engine owns the voice — on the
   * built-in cedar path the model produces its own audio and we have
   * nothing to synthesise through. `end_call` is skipped: the call is
   * ending, so there's no gap worth filling.
   */
  private scheduleFiller(toolName: string): void {
    if (!this.filler) return;
    if (!this.tts && !this.ttsStreamer) return;
    if (toolName === "end_call") return;
    this.cancelFiller();
    const timer = setTimeout(() => {
      this.fillerTimer = null;
      this.maybeSpeakFiller();
    }, this.filler.delayMs);
    // Don't let a pending filler keep the worker's event loop alive during
    // teardown; close()/the closed event clear it anyway.
    timer.unref?.();
    this.fillerTimer = timer;
  }

  /** Clear any pending filler timer. Idempotent. */
  private cancelFiller(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
  }

  /**
   * Fired when a tool call has stayed in flight past `delayMs`. Speak one
   * short filler UNLESS the agent is already talking (its real reply beat
   * the timer) or it finished speaking within `graceMs` (the model almost
   * certainly already acknowledged the caller, e.g. "let me check" — a
   * second filler would stack awkwardly).
   */
  private maybeSpeakFiller(): void {
    if (!this.filler) return;
    if (this.isSpeaking()) return;
    if (Date.now() - this.lastOutputAt < this.filler.graceMs) return;
    this.speakFiller(this.nextFillerPhrase());
  }

  /** True when the agent currently has audio in flight to the caller. */
  private isSpeaking(): boolean {
    if (this.ttsStreamer) return this.ttsStream !== null;
    return this.ttsDraining || this.ttsQueue.length > 0;
  }

  /** Pick the next filler phrase, never repeating the previous one. */
  private nextFillerPhrase(): string {
    const phrases = this.filler!.phrases;
    if (phrases.length === 1) return phrases[0]!;
    let idx = Math.floor(Math.random() * phrases.length);
    if (idx === this.lastFillerIndex) idx = (idx + 1) % phrases.length;
    this.lastFillerIndex = idx;
    return phrases[idx]!;
  }

  /**
   * Voice a filler utterance through whichever external-TTS path is wired.
   * On the streaming path it rides a throwaway session pinned to a
   * synthetic item key, so the next real turn (a different key) transitions
   * off it cleanly via {@link driveTtsStream}. On the per-utterance path it
   * just joins the synthesis queue ahead of the reply.
   */
  private speakFiller(text: string): void {
    if (this.ttsStreamer) {
      this.openTtsStream(FILLER_STREAM_ITEM_KEY);
      if (this.ttsStream) {
        this.ttsStream.pushText(text);
        this.ttsStreamPushed = text.length;
        this.ttsStream.flush();
        this.ttsStream.end();
      }
    } else if (this.tts) {
      this.enqueueTts(text);
    }
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

  // ---- Streaming external TTS (ElevenLabs stream-input WS) ------------

  /**
   * Feed the agent's streaming output text into a per-turn streaming TTS
   * session. Opens a session on the first delta of a turn, pushes only the
   * newly-arrived text (never re-pushing), nudges generation at sentence
   * boundaries for snappy audio, and ends the session when the turn
   * finalises. `next` is the turn's accumulated text so far.
   */
  private driveTtsStream(key: string, next: string, done: boolean): void {
    if (!this.ttsStreamer) return;
    // A new output item means the previous turn is over (turns are
    // sequential); end its session defensively if it somehow lingered, and
    // open a fresh one pinned to this item.
    if (this.ttsStreamItemId !== key) {
      if (this.ttsStream) this.ttsStream.end();
      this.openTtsStream(key);
    }
    if (!this.ttsStream) return;
    const newText = next.slice(this.ttsStreamPushed);
    if (newText.length > 0) {
      this.ttsStream.pushText(newText);
      this.ttsStreamPushed = next.length;
      // A terminator in the just-arrived text means a sentence just
      // completed — flush so ElevenLabs voices it now instead of waiting
      // for its chunk schedule to fill.
      if (/[.!?…]/.test(newText)) this.ttsStream.flush();
    }
    if (done && this.ttsStream) {
      // Signal end-of-text but KEEP the session reference: the engine is
      // still streaming this turn's audio back. The session releases itself
      // via `onDone` (see openTtsStream) once the audio is fully delivered.
      this.ttsStream.end();
    }
  }

  /** Open a streaming session for one agent turn and wire its callbacks. */
  private openTtsStream(itemId: string): void {
    if (!this.ttsStreamer) return;
    this.ttsStreamItemId = itemId;
    this.ttsStreamPushed = 0;
    const session = this.ttsStreamer.openSession({
      onFrame: (frame) => {
        // Drop frames once this session has been replaced or aborted so we
        // never talk over a newer turn or a barged-in caller.
        if (this.ttsStream !== session) return;
        this.sink.writeAudioBase64(frame);
      },
      onError: (err) => {
        // Tear down the vendor connection — an errored session must not be
        // left open streaming audio we'd only discard for the rest of the
        // turn. abort() is idempotent and suppresses any trailing onClosed.
        session.abort();
        // Drop the session but KEEP `ttsStreamItemId` so the rest of this
        // (now voice-less) turn's deltas are ignored rather than reopening
        // a fresh session and re-speaking from the top.
        if (this.ttsStream === session) this.clearTtsStreamRef();
        // A failed turn loses its audio but must NOT end the call.
        this.emit("session.error", {
          source: "tts",
          code: "tts_stream_failed",
          message: err.message,
        });
      },
      onDone: () => {
        // Natural completion — the turn is fully over, so forget the item
        // id too; the next turn (new id, or the synthetic fallback key)
        // opens a fresh session.
        if (this.ttsStream === session) this.resetTtsStream();
      },
    });
    this.ttsStream = session;
  }

  /** Drop the active session reference but remember which item it voiced. */
  private clearTtsStreamRef(): void {
    this.ttsStream = null;
  }

  /** Drop the session AND forget the item — a turn fully completed. */
  private resetTtsStream(): void {
    this.ttsStream = null;
    this.ttsStreamItemId = null;
    this.ttsStreamPushed = 0;
  }

  /**
   * Caller interrupted while a streaming session was playing: abort it (the
   * session goes silent immediately) and flush whatever Twilio has buffered
   * so the agent stops mid-word. Keep `ttsStreamItemId` so any in-flight
   * deltas for the interrupted turn are ignored — never re-opened and
   * re-spoken over the caller.
   */
  private bargeInStream(): void {
    if (this.ttsStream) {
      this.ttsStream.abort();
      this.clearTtsStreamRef();
    }
    this.sink.clearQueuedAudio?.();
  }

  // ---- Per-utterance external TTS (ElevenLabs HTTP) -------------------

  /**
   * Stream complete sentences from an in-progress agent turn to the TTS
   * queue the moment each one lands. `accumulated` is the turn's text so
   * far; we synthesise every whole sentence past the last flushed offset
   * and remember how far we've gotten. Partial trailing text waits for the
   * next delta (or the turn's `done`, which flushes the remainder).
   */
  private flushSpeakableSentences(key: string, accumulated: string): void {
    const flushedLen = this.ttsFlushed.get(key) ?? 0;
    const pending = accumulated.slice(flushedLen);
    const boundary = lastSpeakableBoundary(pending);
    if (boundary <= 0) return;
    this.ttsFlushed.set(key, flushedLen + boundary);
    const chunk = pending.slice(0, boundary).trim();
    if (chunk.length > 0) this.enqueueTts(chunk);
  }

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
