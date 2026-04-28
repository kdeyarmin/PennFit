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
  source: "openai" | "tool";
  code: string;
  message: string;
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

  // Buffer for input STT deltas — coalesce until `done` fires so each
  // patient turn becomes ONE messages-table row, not N. Keyed on
  // `itemId` so interleaved items don't bleed into each other.
  private readonly inputBuf = new Map<string, string>();
  private readonly outputBuf = new Map<string, string>();

  constructor(opts: BridgeOptions) {
    super();
    this.client = opts.client;
    this.sink = opts.sink;
    this.dispatcher = opts.dispatcher;
    this.wireRealtimeEvents();
  }

  /** Call when the upstream Twilio Media Stream delivers audio. */
  forwardCallerAudio(base64Mulaw: string): void {
    this.client.appendAudio(base64Mulaw);
  }

  /** Stop both sides cleanly. Idempotent. */
  close(reason: string): void {
    this.client.close(1000, reason);
  }

  private wireRealtimeEvents(): void {
    this.client.on("open", () => {
      this.emit("session.opened");
    });

    this.client.on("audio.delta", (delta) => {
      this.sink.writeAudioBase64(delta.audioBase64);
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
        }
      } else {
        buf.set(key, next);
      }
    });

    this.client.on("tool.call", (call) => {
      void this.handleToolCall(call.callId, call.name, call.argumentsJson);
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
